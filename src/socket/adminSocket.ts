import { parse } from "cookie";
import type { Server as HttpServer } from "http";
import { Server, type Socket } from "socket.io";
import { ACCESS_COOKIE_NAME } from "../lib/authCookies";
import { verifyAccessToken } from "../services/auth.service";
import type { BusinessUserRole } from "../types/auth";

const LOG = "[adminSocket]";

let io: Server | null = null;

function handshakeDebug(socket: Socket): string {
  const h = socket.handshake.headers;
  const hasAuthToken =
    typeof socket.handshake.auth === "object" &&
    socket.handshake.auth !== null &&
    typeof (socket.handshake.auth as { token?: unknown }).token === "string" &&
    String((socket.handshake.auth as { token?: string }).token).length > 0;
  const hasBearer = typeof h.authorization === "string" && /^Bearer\s+\S+/i.test(h.authorization);
  const hasCookieHeader = typeof h.cookie === "string" && h.cookie.length > 0;
  const hasAccessCookie =
    hasCookieHeader &&
    Boolean(parse(h.cookie!)[ACCESS_COOKIE_NAME]);
  return `auth.token=${hasAuthToken} bearer=${hasBearer} cookieHeader=${hasCookieHeader} accessCookie=${hasAccessCookie}`;
}

function roomSize(server: Server, room: string): number {
  return server.sockets.adapter.rooms.get(room)?.size ?? 0;
}

function adminRoom(businessId: string): string {
  return `admin:${businessId}`;
}

const ADMIN_NOTIFICATION_ROLES = new Set<BusinessUserRole>(["OWNER", "ADMIN"]);

function getTokenFromHandshake(socket: Socket): string | undefined {
  const auth = socket.handshake.auth;
  if (typeof auth === "object" && auth !== null) {
    const t = (auth as { token?: unknown }).token;
    if (typeof t === "string" && t.length > 0) {
      return t;
    }
  }
  const authHeader = socket.handshake.headers.authorization;
  if (typeof authHeader === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
    if (m?.[1]) {
      return m[1];
    }
  }
  const rawCookie = socket.handshake.headers.cookie;
  if (typeof rawCookie === "string") {
    const cookies = parse(rawCookie);
    const c = cookies[ACCESS_COOKIE_NAME];
    if (typeof c === "string" && c.length > 0) {
      return c;
    }
  }
  return undefined;
}

function parseCorsOrigins(): string[] | boolean {
  const raw = process.env.CORS_ORIGIN ?? "http://localhost:3000";
  const list = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) {
    return true;
  }
  return list;
}

/**
 * Socket.IO para el panel admin: sala por negocio `admin:<businessId>`.
 * Cliente: `io(url, { auth: { token }, withCredentials: true })` o cookie HttpOnly.
 */
export function attachAdminSocket(httpServer: HttpServer): Server {
  if (io) {
    console.warn(`${LOG} attachAdminSocket: ya inicializado (idempotente)`);
    return io;
  }

  const corsOrigins = parseCorsOrigins();
  console.log(
    `${LOG} inicializando path=/socket.io corsOrigin=${JSON.stringify(corsOrigins)} cookieName=${ACCESS_COOKIE_NAME}`
  );

  io = new Server(httpServer, {
    path: "/socket.io",
    cors: {
      origin: corsOrigins,
      credentials: true,
      methods: ["GET", "POST"]
    }
  });

  io.engine.on("connection_error", (err) => {
    console.error(`${LOG} engine connection_error`, err.req?.url, err.message);
  });

  io.use((socket, next) => {
    const token = getTokenFromHandshake(socket);
    const xfProto = socket.handshake.headers["x-forwarded-proto"];
    const host = socket.handshake.headers.host;
    if (!token) {
      console.warn(
        `${LOG} handshake rechazado: sin token socket.id=${socket.id} ${handshakeDebug(socket)} transport=${socket.conn.transport.name} host=${host ?? "?"} x-forwarded-proto=${xfProto ?? "?"}`
      );
      next(new Error("UNAUTHORIZED"));
      return;
    }
    try {
      const payload = verifyAccessToken(token);
      socket.data.userId = payload.userId;
      socket.data.businessId = payload.businessId;
      socket.data.role = payload.role;
      console.log(
        `${LOG} handshake ok socket.id=${socket.id} userId=${payload.userId} businessId=${payload.businessId} role=${payload.role}`
      );
      next();
    } catch (e) {
      const name = e instanceof Error ? e.name : "Error";
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(
        `${LOG} handshake rechazado: JWT inválido socket.id=${socket.id} ${handshakeDebug(socket)} err=${name} ${msg}`
      );
      next(new Error("UNAUTHORIZED"));
    }
  });

  io.on("connection", (socket) => {
    const businessId = socket.data.businessId as string | null | undefined;
    const role = socket.data.role as BusinessUserRole | undefined;
    if (!businessId) {
      if (role === "SUPER_ADMIN") {
        console.log(
          `${LOG} conexión SUPER_ADMIN sin tenant (sin sala admin) socket.id=${socket.id}`
        );
        return;
      }
      console.warn(`${LOG} connection sin businessId, desconectando socket.id=${socket.id}`);
      socket.disconnect(true);
      return;
    }
    if (!role || !ADMIN_NOTIFICATION_ROLES.has(role)) {
      console.warn(
        `${LOG} conexión sin permiso para notificaciones admin socket.id=${socket.id} businessId=${businessId} role=${role ?? "?"}`
      );
      socket.disconnect(true);
      return;
    }
    const room = adminRoom(businessId);
    void Promise.resolve(socket.join(room)).then(() => {
      const size = roomSize(io!, room);
      console.log(
        `${LOG} cliente admin en sala socket.id=${socket.id} room=${room} role=${role} roomSize=${size} transport=${socket.conn.transport.name}`
      );
    });
  });

  return io;
}

/** Payload unificado del evento Socket `admin:reservation` (tipar el cliente admin). */
export type AdminReservationRealtimePayload =
  | {
      type: "reservation.created";
      businessId: string;
      reservationId: string;
      at: string;
    }
  | {
      type: "reservation.cancelled";
      businessId: string;
      reservationId: string;
      /** Estado persistido, p. ej. `closed` al cancelar desde el bot */
      status: string;
      at: string;
    }
  | {
      type: "reservation.edit_started";
      businessId: string;
      /** Reserva que el usuario va a reemplazar/editar al completar el flujo */
      reservationId: string;
      at: string;
    };

function emitAdminReservationChannel(
  businessId: string,
  body: AdminReservationRealtimePayload,
  logLabel: string
): void {
  if (!io) {
    console.error(
      `${LOG} emit admin:reservation OMITIDO (${logLabel}): Socket.IO no inicializado businessId=${businessId}`
    );
    return;
  }
  const room = adminRoom(businessId);
  const before = roomSize(io, room);
  io.to(room).emit("admin:reservation", body);
  const after = roomSize(io, room);
  console.log(
    `${LOG} emit admin:reservation type=${body.type} room=${room} socketsEnSala=${before} (tras emit=${after})`
  );
}

export function emitAdminReservationCreated(
  businessId: string,
  payload: { reservationId: string }
): void {
  emitAdminReservationChannel(
    businessId,
    {
      type: "reservation.created",
      businessId,
      reservationId: payload.reservationId,
      at: new Date().toISOString()
    },
    "created"
  );
}

export function emitAdminReservationCancelled(
  businessId: string,
  payload: { reservationId: string; status: string }
): void {
  emitAdminReservationChannel(
    businessId,
    {
      type: "reservation.cancelled",
      businessId,
      reservationId: payload.reservationId,
      status: payload.status,
      at: new Date().toISOString()
    },
    "cancelled"
  );
}

export function emitAdminReservationEditStarted(
  businessId: string,
  payload: { reservationId: string }
): void {
  emitAdminReservationChannel(
    businessId,
    {
      type: "reservation.edit_started",
      businessId,
      reservationId: payload.reservationId,
      at: new Date().toISOString()
    },
    "edit_started"
  );
}

/** Payload del evento Socket `admin:order` (creación o cambio de estado / pago). */
export type AdminOrderRealtimePayload =
  | {
      type: "order.created";
      businessId: string;
      orderId: string;
      total: string;
      currency: string;
      at: string;
    }
  | {
      type: "order.status_changed";
      businessId: string;
      orderId: string;
      status: string;
      at: string;
    }
  | {
      type: "order.payment_status_changed";
      businessId: string;
      orderId: string;
      payment_status: string;
      at: string;
    };

function emitAdminOrderChannel(
  businessId: string,
  body: AdminOrderRealtimePayload,
  logDetail: string
): void {
  if (!io) {
    console.error(
      `${LOG} emit admin:order OMITIDO (${logDetail}): Socket.IO no inicializado businessId=${businessId}`
    );
    return;
  }
  const room = adminRoom(businessId);
  const before = roomSize(io, room);
  io.to(room).emit("admin:order", body);
  const after = roomSize(io, room);
  console.log(
    `${LOG} emit admin:order type=${body.type} room=${room} socketsEnSala=${before} (tras emit=${after})`
  );
}

export function emitAdminOrderCreated(
  businessId: string,
  payload: {
    orderId: string;
    total: string;
    currency: string;
  }
): void {
  emitAdminOrderChannel(
    businessId,
    {
      type: "order.created",
      businessId,
      orderId: payload.orderId,
      total: payload.total,
      currency: payload.currency,
      at: new Date().toISOString()
    },
    "created"
  );
}

export function emitAdminOrderStatusChanged(
  businessId: string,
  payload: { orderId: string; status: string }
): void {
  emitAdminOrderChannel(
    businessId,
    {
      type: "order.status_changed",
      businessId,
      orderId: payload.orderId,
      status: payload.status,
      at: new Date().toISOString()
    },
    "status_changed"
  );
}

export function emitAdminOrderPaymentStatusChanged(
  businessId: string,
  payload: { orderId: string; payment_status: string }
): void {
  emitAdminOrderChannel(
    businessId,
    {
      type: "order.payment_status_changed",
      businessId,
      orderId: payload.orderId,
      payment_status: payload.payment_status,
      at: new Date().toISOString()
    },
    "payment_status_changed"
  );
}

/** Payloads del canal Socket `admin:whatsapp` (mensajes y señales de inbox). */
export type AdminWhatsappRealtimePayload =
  | {
      type: "whatsapp.message_created";
      businessId: string;
      conversationId: string;
      messageId: string;
      sender: string;
      message: string;
      isAiGenerated: boolean;
      createdAt: string;
    }
  | {
      type: "whatsapp.support_requested";
      businessId: string;
      /** Misma clave que en `GET /api/admin/whatsapp/messages` → `conversation.id` (UUID). */
      conversationId: string;
      customerId: string | null;
      customerPhone: string | null;
      customerName: string | null;
      at: string;
    };

function emitAdminWhatsappChannel(
  businessId: string,
  body: AdminWhatsappRealtimePayload
): void {
  if (!io) {
    console.error(
      `${LOG} emit admin:whatsapp OMITIDO: Socket.IO no inicializado businessId=${businessId}`
    );
    return;
  }
  const room = adminRoom(businessId);
  const before = roomSize(io, room);
  io.to(room).emit("admin:whatsapp", body);
  const after = roomSize(io, room);
  console.log(
    `${LOG} emit admin:whatsapp type=${body.type} room=${room} socketsEnSala=${before} (tras emit=${after})`
  );
}

export function emitAdminWhatsappMessageCreated(
  businessId: string,
  payload: {
    conversationId: string;
    messageId: string;
    sender: string;
    message: string;
    isAiGenerated: boolean;
    createdAt: string;
  }
): void {
  emitAdminWhatsappChannel(businessId, {
    type: "whatsapp.message_created",
    businessId,
    conversationId: payload.conversationId,
    messageId: payload.messageId,
    sender: payload.sender,
    message: payload.message,
    isAiGenerated: payload.isAiGenerated,
    createdAt: payload.createdAt
  });
}

/**
 * Cliente pidió soporte humano: el panel puede abrir el chat con `conversationId`
 * (mismo identificador que en rutas `/whatsapp/conversations/:conversationId/...`).
 */
export function emitAdminWhatsappSupportRequested(
  businessId: string,
  payload: {
    conversationId: string;
    customerId: string | null;
    customerPhone: string | null;
    customerName: string | null;
  }
): void {
  emitAdminWhatsappChannel(businessId, {
    type: "whatsapp.support_requested",
    businessId,
    conversationId: payload.conversationId,
    customerId: payload.customerId,
    customerPhone: payload.customerPhone,
    customerName: payload.customerName,
    at: new Date().toISOString()
  });
}
