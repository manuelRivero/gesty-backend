import {
  FulfillmentType,
  OrderPaymentStatus,
  OrderStatus,
  Prisma
} from "@prisma/client";
import {
  activePriceSelect,
  resolveEffectivePrice
} from "../helpers/menuItemPrice.helper";
import { prisma } from "../lib/prisma";
import { findOrCreateCustomer } from "../repositories/customer.repository";
import { emitAdminOrderCreated } from "../socket/adminSocket";
import { getBusinessConfig } from "./businessConfig.service";
import { getBusinessOpenInfo } from "./businessHours.service";
import {
  hasVariations,
  matchVariation
} from "./menu/menuItemVariations";
import { normalizePhoneDigits } from "./ownerAssistant/matchOwnerPhone";
import { computeOrderPricing } from "./pricing.service";
import { resolveActivePublicBusiness } from "./publicStorefront.service";

/** Cobro manual en mostrador — nunca online/MP. */
export const COUNTER_PAYMENT_METHOD = "cash" as const;

export type PublicOrderLineInput = {
  menuItemId: string;
  quantity: number;
  variation?: string | null;
  notes?: string | null;
};

export type CreatePublicCounterOrderInput = {
  slugOrId: string;
  customer: {
    name?: string | null;
    phone: string;
  };
  items: PublicOrderLineInput[];
  /** Solo TAKE_AWAY en v1 (autoservicio en local). */
  fulfillmentType?: "TAKE_AWAY";
  notes?: string | null;
};

export type PublicOrderLineResult = {
  menuItemId: string;
  name: string;
  quantity: number;
  variation: string | null;
  notes: string | null;
  unitPrice: string;
  lineTotal: string;
};

/** Misma forma para POST 201 y GET de seguimiento (poll). */
export type PublicOrderView = {
  orderId: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  paymentMethod: string;
  fulfillmentType: FulfillmentType;
  currencyCode: string;
  total: string;
  customer: {
    id: string;
    name: string | null;
    phone: string;
  };
  items: PublicOrderLineResult[];
  createdAt: string;
};

/** @deprecated Prefer PublicOrderView — alias del create. */
export type CreatePublicCounterOrderResult = PublicOrderView;

export class PublicOrderError extends Error {
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
    this.name = "PublicOrderError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

function assertPhone(raw: string): string {
  const digits = normalizePhoneDigits(raw);
  if (digits.length < 8 || digits.length > 15) {
    throw new PublicOrderError(
      "INVALID_PHONE",
      400,
      "Teléfono inválido: usá código de país + número (solo dígitos)"
    );
  }
  return digits;
}

type ResolvedLine = {
  menuItemId: string;
  name: string;
  quantity: number;
  variation: string | null;
  notes: string | null;
  unitPrice: Prisma.Decimal;
  listPrice: Prisma.Decimal | null;
  discountAmount: Prisma.Decimal | null;
  servesPeople: number | null;
};

async function resolveLines(params: {
  businessId: string;
  currencyCode: string;
  items: PublicOrderLineInput[];
}): Promise<ResolvedLine[]> {
  const ids = [...new Set(params.items.map((i) => i.menuItemId))];
  const rows = await prisma.menu_item.findMany({
    where: {
      id: { in: ids },
      business_id: params.businessId
    },
    select: {
      id: true,
      name: true,
      is_available: true,
      serves_people: true,
      variations: true,
      discount_type: true,
      discount_value: true,
      menu_item_price: activePriceSelect(params.currencyCode)
    }
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const resolved: ResolvedLine[] = [];

  for (const line of params.items) {
    const item = byId.get(line.menuItemId);
    if (!item) {
      throw new PublicOrderError(
        "ITEM_NOT_FOUND",
        400,
        "Hay productos que no pertenecen a este local",
        { menuItemId: line.menuItemId }
      );
    }
    if (!item.is_available) {
      throw new PublicOrderError(
        "ITEM_UNAVAILABLE",
        400,
        `"${item.name}" no está disponible`,
        { menuItemId: item.id }
      );
    }
    if (!item.menu_item_price[0]) {
      throw new PublicOrderError(
        "PRICE_UNAVAILABLE",
        400,
        `"${item.name}" no tiene precio activo`,
        { menuItemId: item.id }
      );
    }

    let variation: string | null = null;
    if (hasVariations(item)) {
      const raw = line.variation?.trim() ?? "";
      if (!raw) {
        throw new PublicOrderError(
          "VARIATION_REQUIRED",
          400,
          `"${item.name}" requiere una variación`,
          { menuItemId: item.id, variations: item.variations }
        );
      }
      const match = matchVariation(raw, item.variations);
      if (match.status === "ok") {
        variation = match.value;
      } else if (match.status === "ambiguous") {
        throw new PublicOrderError(
          "VARIATION_AMBIGUOUS",
          400,
          `Variación ambigua para "${item.name}"`,
          { menuItemId: item.id, candidates: match.candidates }
        );
      } else {
        throw new PublicOrderError(
          "VARIATION_INVALID",
          400,
          `Variación inválida para "${item.name}"`,
          { menuItemId: item.id, variations: item.variations }
        );
      }
    } else if (line.variation?.trim()) {
      throw new PublicOrderError(
        "VARIATION_NOT_ALLOWED",
        400,
        `"${item.name}" no admite variaciones`,
        { menuItemId: item.id }
      );
    }

    const price = resolveEffectivePrice(item);
    resolved.push({
      menuItemId: item.id,
      name: item.name,
      quantity: line.quantity,
      variation,
      notes: line.notes?.trim() ? line.notes.trim().slice(0, 500) : null,
      unitPrice: price.finalPrice,
      listPrice: price.hasDiscount ? price.listPrice : null,
      discountAmount: price.hasDiscount ? price.discountAmount : null,
      servesPeople: item.serves_people ?? null
    });
  }

  return resolved;
}

/**
 * Crea un pedido de autoservicio / mostrador.
 * Aislado de WhatsApp draft, conversation y Mercado Pago:
 * `payment_method=cash`, `payment_status=unpaid`, `status=placed`.
 */
export async function createPublicCounterOrder(
  input: CreatePublicCounterOrderInput
): Promise<PublicOrderView> {
  const business = await resolveActivePublicBusiness(input.slugOrId);
  if (!business) {
    throw new PublicOrderError(
      "LOCAL_UNAVAILABLE",
      404,
      "local no disponible"
    );
  }

  if (!business.currency_code) {
    throw new PublicOrderError(
      "CURRENCY_NOT_SET",
      503,
      "El local no tiene moneda configurada"
    );
  }

  const config = await getBusinessConfig(business.id);
  if (!config.orders_enabled) {
    throw new PublicOrderError(
      "ORDERS_DISABLED",
      403,
      "Este local no toma pedidos por este canal"
    );
  }

  const fulfillmentType = FulfillmentType.TAKE_AWAY;
  if (!config.takeaway_enabled) {
    throw new PublicOrderError(
      "TAKEAWAY_DISABLED",
      403,
      "Este local no tiene retiro en mostrador habilitado"
    );
  }

  const open = await getBusinessOpenInfo({
    businessId: business.id,
    timezone: business.timezone
  });
  if (!open.isOpen && !config.orders_when_closed) {
    throw new PublicOrderError(
      "CLOSED",
      403,
      open.nextOpenText
        ? `El local está cerrado. Abrimos ${open.nextOpenText}`
        : "El local está cerrado"
    );
  }

  const phone = assertPhone(input.customer.phone);
  const customerName = input.customer.name?.trim()
    ? input.customer.name.trim().slice(0, 120)
    : undefined;

  const lines = await resolveLines({
    businessId: business.id,
    currencyCode: business.currency_code,
    items: input.items
  });

  const pricing = computeOrderPricing(
    lines.map((l) => ({
      quantity: l.quantity,
      unit_price: l.unitPrice,
      list_price: l.listPrice,
      discount_amount: l.discountAmount
    }))
  );

  const customer = await findOrCreateCustomer(
    business.id,
    phone,
    customerName
  );

  // Nota de pedido: no hay campo order.notes; si viene, se anexa a la 1ª línea.
  const orderNote = input.notes?.trim()
    ? input.notes.trim().slice(0, 500)
    : null;
  if (orderNote && lines[0]) {
    lines[0] = {
      ...lines[0],
      notes: lines[0].notes
        ? `${lines[0].notes} | Pedido: ${orderNote}`
        : `Pedido: ${orderNote}`
    };
  }

  const order = await prisma.orders.create({
    data: {
      business_id: business.id,
      customer_id: customer.id,
      conversation_id: null,
      status: OrderStatus.placed,
      payment_status: OrderPaymentStatus.unpaid,
      payment_method: COUNTER_PAYMENT_METHOD,
      currency_code: business.currency_code,
      total_amount: pricing.total,
      fulfillment_type: fulfillmentType,
      delivery_address_snapshot: {},
      order_item: {
        create: lines.map((l) => ({
          menu_item_id: l.menuItemId,
          quantity: l.quantity,
          unit_price: l.unitPrice,
          list_price: l.listPrice ?? undefined,
          discount_amount: l.discountAmount ?? undefined,
          notes: l.notes ?? undefined,
          variation: l.variation ?? undefined,
          serves_people: l.servesPeople ?? undefined
        }))
      }
    },
    select: {
      id: true,
      status: true,
      payment_status: true,
      payment_method: true,
      fulfillment_type: true,
      currency_code: true,
      total_amount: true,
      created_at: true
    }
  });

  emitAdminOrderCreated(business.id, {
    orderId: order.id,
    total: String(pricing.total),
    currency: business.currency_code
  });

  return {
    orderId: order.id,
    status: order.status,
    paymentStatus: order.payment_status,
    paymentMethod: COUNTER_PAYMENT_METHOD,
    fulfillmentType,
    currencyCode: order.currency_code,
    total: Number(pricing.total).toFixed(2),
    customer: {
      id: customer.id,
      name: customer.name ?? null,
      phone: customer.phone_number
    },
    items: lines.map((l) => ({
      menuItemId: l.menuItemId,
      name: l.name,
      quantity: l.quantity,
      variation: l.variation,
      notes: l.notes,
      unitPrice: l.unitPrice.toFixed(2),
      lineTotal: l.unitPrice.mul(l.quantity).toFixed(2)
    })),
    createdAt: order.created_at.toISOString()
  };
}

/**
 * Seguimiento post-checkout (Fase E).
 * Sin JWT: el orderId (UUID) es el secreto. 404 si no existe o no es del slug.
 */
export async function getPublicCounterOrder(params: {
  slugOrId: string;
  orderId: string;
}): Promise<PublicOrderView> {
  const business = await resolveActivePublicBusiness(params.slugOrId);
  if (!business) {
    throw new PublicOrderError(
      "LOCAL_UNAVAILABLE",
      404,
      "local no disponible"
    );
  }

  const order = await prisma.orders.findFirst({
    where: {
      id: params.orderId,
      business_id: business.id
    },
    select: {
      id: true,
      status: true,
      payment_status: true,
      payment_method: true,
      fulfillment_type: true,
      currency_code: true,
      total_amount: true,
      created_at: true,
      customer: {
        select: {
          id: true,
          name: true,
          phone_number: true
        }
      },
      order_item: {
        orderBy: { created_at: "asc" },
        select: {
          menu_item_id: true,
          quantity: true,
          unit_price: true,
          notes: true,
          variation: true,
          menu_item: {
            select: { name: true }
          }
        }
      }
    }
  });

  if (!order) {
    throw new PublicOrderError("ORDER_NOT_FOUND", 404, "Pedido no encontrado");
  }

  // Storefront solo TAKE_AWAY; si un pedido viejo no tiene fulfillment, default.
  const fulfillmentType =
    order.fulfillment_type ?? FulfillmentType.TAKE_AWAY;

  return {
    orderId: order.id,
    status: order.status,
    paymentStatus: order.payment_status,
    paymentMethod: order.payment_method ?? COUNTER_PAYMENT_METHOD,
    fulfillmentType,
    currencyCode: order.currency_code,
    total: order.total_amount
      ? Number(order.total_amount).toFixed(2)
      : "0.00",
    customer: {
      id: order.customer.id,
      name: order.customer.name ?? null,
      phone: order.customer.phone_number
    },
    items: order.order_item.map((line) => {
      const unit = new Prisma.Decimal(line.unit_price);
      return {
        menuItemId: line.menu_item_id,
        name: line.menu_item.name,
        quantity: line.quantity,
        variation: line.variation ?? null,
        notes: line.notes ?? null,
        unitPrice: unit.toFixed(2),
        lineTotal: unit.mul(line.quantity).toFixed(2)
      };
    }),
    createdAt: order.created_at.toISOString()
  };
}
