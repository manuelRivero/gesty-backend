import {
  FulfillmentType,
  OrderStatus,
  type storefront_order_push_subscription
} from "@prisma/client";
import webpush from "web-push";
import { env, isWebPushConfigured } from "../config/env";
import { prisma } from "../lib/prisma";
import { resolveActivePublicBusiness } from "./publicStorefront.service";

export class StorefrontPushError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details?: unknown;

  constructor(
    code: string,
    httpStatus: number,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = "StorefrontPushError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

export type PushSubscriptionInput = {
  endpoint: string;
  expirationTime?: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

export type StorefrontPushPayload = {
  title: string;
  body: string;
  url: string;
  orderId: string;
  /** Ref corta para UI / debug (ej. A1B2C3D4). */
  orderRef: string;
  slug: string;
  businessName: string | null;
  status: string;
  tag: string;
};

/** Misma convención que WhatsApp / admin (`#A1B2C3D4`). */
export function shortOrderRef(orderId: string): string {
  return orderId.replace(/-/g, "").slice(0, 8).toUpperCase();
}

/** Estados notifiables por fulfillment (al cambiar status).
 * Pipeline: preparing → ready_for_pickup|shipped → delivered (+ cancelled).
 */
const NOTIFIABLE: Record<
  FulfillmentType,
  ReadonlySet<OrderStatus>
> = {
  [FulfillmentType.TAKE_AWAY]: new Set([
    OrderStatus.preparing,
    OrderStatus.ready_for_pickup,
    OrderStatus.shipped, // legacy si algún camino aún escribe shipped en retiro
    OrderStatus.delivered,
    OrderStatus.cancelled
  ]),
  [FulfillmentType.DELIVERY]: new Set([
    OrderStatus.preparing,
    OrderStatus.shipped,
    OrderStatus.delivered,
    OrderStatus.cancelled
  ])
};

const PREPARING_TAKEAWAY_COPY = {
  title: "En preparación",
  body: "Están armando tu pedido."
} as const;

const PREPARING_DELIVERY_COPY = {
  title: "En preparación",
  body: "Están armando tu pedido para enviarlo."
} as const;

const PICKUP_READY_COPY = {
  title: "Listo para retirar",
  body: "Acercate al mostrador."
} as const;

const DELIVERY_SHIPPED_COPY = {
  title: "En camino",
  body: "El repartidor ya salió hacia tu dirección."
} as const;

const DELIVERED_COPY = {
  title: "Entregado",
  body: "¡Buen provecho!"
} as const;

const CANCELLED_COPY = {
  title: "Pedido cancelado",
  body: "Este pedido fue cancelado."
} as const;

const TERMINAL: ReadonlySet<OrderStatus> = new Set([
  OrderStatus.delivered,
  OrderStatus.cancelled
]);

let vapidConfigured = false;

function ensureVapid(): boolean {
  if (!isWebPushConfigured()) return false;
  if (!vapidConfigured) {
    webpush.setVapidDetails(
      env.VAPID_SUBJECT!.trim(),
      env.VAPID_PUBLIC_KEY!.trim(),
      env.VAPID_PRIVATE_KEY!.trim()
    );
    vapidConfigured = true;
  }
  return true;
}

export function isStorefrontPushConfigured(): boolean {
  return isWebPushConfigured();
}

export function getVapidPublicKey(): string {
  if (!isWebPushConfigured()) {
    throw new StorefrontPushError(
      "PUSH_NOT_CONFIGURED",
      503,
      "Web Push no configurado"
    );
  }
  return env.VAPID_PUBLIC_KEY!.trim();
}

export function isNotifiableStorefrontPush(
  fulfillmentType: FulfillmentType | null | undefined,
  status: OrderStatus
): boolean {
  const ft = fulfillmentType ?? FulfillmentType.TAKE_AWAY;
  return NOTIFIABLE[ft]?.has(status) ?? false;
}

/**
 * Copy base por status + modalidad, luego personaliza con nombre del local y ref.
 * Sin logo (no hay asset de business aún).
 */
export function buildStorefrontPushCopy(
  status: OrderStatus,
  fulfillmentType?: FulfillmentType | null,
  opts?: { businessName?: string | null; orderId?: string }
): { title: string; body: string } | null {
  let base: { title: string; body: string } | null = null;

  if (status === OrderStatus.cancelled) {
    base = { ...CANCELLED_COPY };
  } else if (status === OrderStatus.delivered) {
    base = { ...DELIVERED_COPY };
  } else if (status === OrderStatus.preparing) {
    const ft = fulfillmentType ?? FulfillmentType.TAKE_AWAY;
    base =
      ft === FulfillmentType.DELIVERY
        ? { ...PREPARING_DELIVERY_COPY }
        : { ...PREPARING_TAKEAWAY_COPY };
  } else {
    const ft = fulfillmentType ?? FulfillmentType.TAKE_AWAY;
    if (
      status === OrderStatus.ready_for_pickup ||
      (status === OrderStatus.shipped && ft === FulfillmentType.TAKE_AWAY)
    ) {
      base = { ...PICKUP_READY_COPY };
    } else if (
      status === OrderStatus.shipped &&
      ft === FulfillmentType.DELIVERY
    ) {
      base = { ...DELIVERY_SHIPPED_COPY };
    }
  }

  if (!base) return null;

  const name = opts?.businessName?.trim() || null;
  const title = name ? `${name} · ${base.title}` : base.title;

  const orderId = opts?.orderId?.trim();
  const ref = orderId ? shortOrderRef(orderId) : null;
  const body = ref ? `Pedido #${ref} · ${base.body}` : base.body;

  return { title, body };
}

function trackingPath(slug: string, orderId: string): string {
  return `/shopping/${slug}/order/${orderId}`;
}

function buildNotificationUrl(slug: string, orderId: string): string {
  const path = trackingPath(slug, orderId);
  const origin = env.STOREFRONT_PUBLIC_ORIGIN?.replace(/\/$/, "");
  return origin ? `${origin}${path}` : path;
}

function assertPushConfigured(): void {
  if (!isWebPushConfigured()) {
    throw new StorefrontPushError(
      "PUSH_NOT_CONFIGURED",
      503,
      "Web Push no configurado"
    );
  }
}

function validateSubscription(
  raw: unknown
): PushSubscriptionInput {
  if (!raw || typeof raw !== "object") {
    throw new StorefrontPushError(
      "INVALID_SUBSCRIPTION",
      400,
      "subscription inválida"
    );
  }
  const sub = raw as Record<string, unknown>;
  const endpoint = typeof sub.endpoint === "string" ? sub.endpoint.trim() : "";
  if (!endpoint || !/^https:\/\//i.test(endpoint) || endpoint.length > 2048) {
    throw new StorefrontPushError(
      "INVALID_SUBSCRIPTION",
      400,
      "endpoint inválido"
    );
  }
  const keys = sub.keys;
  if (!keys || typeof keys !== "object") {
    throw new StorefrontPushError(
      "INVALID_SUBSCRIPTION",
      400,
      "keys inválidas"
    );
  }
  const k = keys as Record<string, unknown>;
  const p256dh = typeof k.p256dh === "string" ? k.p256dh.trim() : "";
  const auth = typeof k.auth === "string" ? k.auth.trim() : "";
  if (!p256dh || !auth || p256dh.length > 256 || auth.length > 256) {
    throw new StorefrontPushError(
      "INVALID_SUBSCRIPTION",
      400,
      "keys p256dh/auth inválidas"
    );
  }
  return {
    endpoint,
    expirationTime:
      typeof sub.expirationTime === "number" ? sub.expirationTime : null,
    keys: { p256dh, auth }
  };
}

async function loadOrderForPush(params: {
  slugOrId: string;
  orderId: string;
}): Promise<{
  orderId: string;
  businessId: string;
  slug: string;
  status: OrderStatus;
  fulfillmentType: FulfillmentType;
}> {
  const business = await resolveActivePublicBusiness(params.slugOrId);
  if (!business) {
    throw new StorefrontPushError(
      "LOCAL_UNAVAILABLE",
      404,
      "local no disponible"
    );
  }

  const order = await prisma.orders.findFirst({
    where: { id: params.orderId, business_id: business.id },
    select: {
      id: true,
      status: true,
      fulfillment_type: true,
      business_id: true
    }
  });

  if (!order) {
    throw new StorefrontPushError("ORDER_NOT_FOUND", 404, "Pedido no encontrado");
  }

  const slug = business.slug?.trim() || business.id;

  return {
    orderId: order.id,
    businessId: order.business_id,
    slug,
    status: order.status,
    fulfillmentType: order.fulfillment_type ?? FulfillmentType.TAKE_AWAY
  };
}

/**
 * Upsert por endpoint. Varias subscriptions por pedido OK (multi-device).
 */
export async function upsertStorefrontPushSubscription(params: {
  slugOrId: string;
  orderId: string;
  subscription: unknown;
  userAgent?: string | null;
}): Promise<void> {
  assertPushConfigured();

  const sub = validateSubscription(params.subscription);
  const order = await loadOrderForPush({
    slugOrId: params.slugOrId,
    orderId: params.orderId
  });

  if (TERMINAL.has(order.status)) {
    throw new StorefrontPushError(
      "ORDER_TERMINAL",
      409,
      "El pedido ya está cerrado; no se aceptan suscripciones"
    );
  }

  const ua =
    typeof params.userAgent === "string" && params.userAgent.trim()
      ? params.userAgent.trim().slice(0, 512)
      : null;

  await prisma.storefront_order_push_subscription.upsert({
    where: { endpoint: sub.endpoint },
    create: {
      order_id: order.orderId,
      business_id: order.businessId,
      endpoint: sub.endpoint,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      user_agent: ua
    },
    update: {
      order_id: order.orderId,
      business_id: order.businessId,
      p256dh: sub.keys.p256dh,
      auth: sub.keys.auth,
      ...(ua != null ? { user_agent: ua } : {})
    }
  });
}

export async function deleteStorefrontPushSubscription(params: {
  slugOrId: string;
  orderId: string;
  endpoint: string;
}): Promise<void> {
  // DELETE es no-op si no hay push / pedido / fila; no exige VAPID.
  const endpoint = params.endpoint?.trim();
  if (!endpoint) {
    throw new StorefrontPushError(
      "INVALID_SUBSCRIPTION",
      400,
      "endpoint inválido"
    );
  }

  const business = await resolveActivePublicBusiness(params.slugOrId);
  if (!business) {
    throw new StorefrontPushError(
      "LOCAL_UNAVAILABLE",
      404,
      "local no disponible"
    );
  }

  await prisma.storefront_order_push_subscription.deleteMany({
    where: {
      endpoint,
      order_id: params.orderId,
      business_id: business.id
    }
  });
}

export async function clearStorefrontPushSubscriptions(
  orderId: string
): Promise<void> {
  await prisma.storefront_order_push_subscription.deleteMany({
    where: { order_id: orderId }
  });
}

function isGoneError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const statusCode = (err as { statusCode?: number }).statusCode;
  return statusCode === 410 || statusCode === 404;
}

async function sendOne(
  row: storefront_order_push_subscription,
  payload: StorefrontPushPayload
): Promise<"ok" | "gone" | "error"> {
  try {
    await webpush.sendNotification(
      {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth }
      },
      JSON.stringify(payload),
      { TTL: 60 * 60 }
    );
    return "ok";
  } catch (err) {
    if (isGoneError(err)) return "gone";
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[StorefrontPush] send failed order=${row.order_id} endpoint=…${row.endpoint.slice(-24)}:`,
      msg
    );
    return "error";
  }
}

/**
 * Best-effort: no lanza. Enviar solo si el status es notifiable para el fulfillment.
 * Tras terminal (delivered/cancelled) limpia subscriptions.
 */
export async function notifyStorefrontOrderStatusChange(params: {
  orderId: string;
  businessId: string;
  status: OrderStatus;
  fulfillmentType?: FulfillmentType | null;
  /** Si ya se conoce el slug, evita un lookup extra. */
  slug?: string | null;
}): Promise<{ attempted: number; sent: number; removed: number }> {
  const empty = { attempted: 0, sent: 0, removed: 0 };

  try {
    const fulfillmentType =
      params.fulfillmentType ?? FulfillmentType.TAKE_AWAY;
    const shouldNotify = isNotifiableStorefrontPush(
      fulfillmentType,
      params.status
    );
    const isTerminal = TERMINAL.has(params.status);

    if (!shouldNotify && !isTerminal) {
      return empty;
    }

    if (shouldNotify && !ensureVapid()) {
      if (isTerminal) {
        await clearStorefrontPushSubscriptions(params.orderId);
      }
      return empty;
    }

    let sent = 0;
    let removed = 0;
    let attempted = 0;

    if (shouldNotify) {
      const rows =
        await prisma.storefront_order_push_subscription.findMany({
          where: { order_id: params.orderId }
        });

      if (rows.length === 0) {
        if (isTerminal) {
          await clearStorefrontPushSubscriptions(params.orderId);
        }
        return empty;
      }

      const biz = await prisma.business.findUnique({
        where: { id: params.businessId },
        select: { slug: true, name: true }
      });
      const businessName = biz?.name?.trim() || null;
      const slug =
        params.slug?.trim() ||
        biz?.slug?.trim() ||
        params.businessId;

      const copy = buildStorefrontPushCopy(
        params.status,
        fulfillmentType,
        { businessName, orderId: params.orderId }
      );
      if (!copy) {
        if (isTerminal) {
          await clearStorefrontPushSubscriptions(params.orderId);
        }
        return empty;
      }

      const orderRef = shortOrderRef(params.orderId);
      const payload: StorefrontPushPayload = {
        title: copy.title,
        body: copy.body,
        url: buildNotificationUrl(slug, params.orderId),
        orderId: params.orderId,
        orderRef,
        slug,
        businessName,
        status: params.status,
        tag: `gesty-order-${params.orderId}`
      };

      attempted = rows.length;
      const goneIds: string[] = [];

      await Promise.all(
        rows.map(async (row) => {
          const result = await sendOne(row, payload);
          if (result === "ok") sent += 1;
          if (result === "gone") goneIds.push(row.id);
        })
      );

      if (goneIds.length > 0) {
        await prisma.storefront_order_push_subscription.deleteMany({
          where: { id: { in: goneIds } }
        });
        removed = goneIds.length;
      }
    }

    if (isTerminal) {
      await clearStorefrontPushSubscriptions(params.orderId);
    }

    return { attempted, sent, removed };
  } catch (err) {
    console.error("[StorefrontPush] notify failed:", err);
    return empty;
  }
}

/**
 * Disparo fire-and-forget tras un cambio de status (no bloquea ni revierte).
 */
export function scheduleStorefrontOrderPush(params: {
  orderId: string;
  businessId: string;
  status: OrderStatus;
  fulfillmentType?: FulfillmentType | null;
  slug?: string | null;
}): void {
  void notifyStorefrontOrderStatusChange(params).catch((err) => {
    console.error("[StorefrontPush] schedule failed:", err);
  });
}
