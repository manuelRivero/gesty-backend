import { FulfillmentType, OrderPaymentStatus, OrderStatus, type Prisma } from "@prisma/client";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import type { AdminPatchableOrderStatus } from "../constants/orderWorkflow";
import { prisma } from "../lib/prisma";
import type { BusinessUserRole } from "../types/auth";
import { notifyCustomerOrderStatusFromAdmin } from "./orderStatusNotification.service";
import {
  emitAdminOrderPaymentStatusChanged,
  emitAdminOrderStatusChanged
} from "../socket/adminSocket";
import { notifyAmbassadorSaleIfNeeded } from "./ambassador/ambassadorSale.service";

dayjs.extend(utc);

const MENU_ITEM_SELECT = {
  id: true,
  business_id: true,
  category_id: true,
  name: true,
  description: true,
  ingredients: true,
  preparation: true,
  is_available: true,
  created_at: true,
  serves_people: true,
  is_featured: true,
  ingredients_notes: true,
  image: true
} as const;

const ORDER_INCLUDE = {
  customer: true,
  currency: true,
  customer_address: true,
  assigned_delivery_user: {
    select: {
      id: true,
      app_user: {
        select: {
          email: true,
          name: true
        }
      }
    }
  },
  conversation: {
    select: {
      id: true,
      channel: true,
      status: true,
      started_at: true,
      last_message_at: true
    }
  },
  order_item: {
    include: {
      menu_item: { select: MENU_ITEM_SELECT }
    },
    orderBy: { created_at: "asc" as const }
  }
} satisfies Prisma.ordersInclude;

export type AdminOrderListInclude = typeof ORDER_INCLUDE;

function parseDateStart(s: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return dayjs.utc(s).startOf("day").toDate();
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error("INVALID_DATE_FROM");
  }
  return d;
}

function parseDateEnd(s: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return dayjs.utc(s).endOf("day").toDate();
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error("INVALID_DATE_TO");
  }
  return d;
}

export type ListAdminOrdersParams = {
  businessId: string;
  page: number;
  pageSize: number;
  orderId?: string;
  dateFrom?: string;
  dateTo?: string;
  customerPhone?: string;
  fulfillmentType?: FulfillmentType;
  assignment?: "all" | "assigned" | "unassigned";
  assignedDeliveryUserId?: string;
  actorRole?: BusinessUserRole;
  actorBusinessUserId?: string;
};

function applyDeliveryAssignmentFilters(
  where: Prisma.ordersWhereInput,
  params: Pick<
    ListAdminOrdersParams,
    | "actorRole"
    | "actorBusinessUserId"
    | "fulfillmentType"
    | "assignment"
    | "assignedDeliveryUserId"
  >
): void {
  if (params.actorRole === "DELIVERY") {
    where.fulfillment_type = FulfillmentType.DELIVERY;
    if (params.actorBusinessUserId) {
      where.assigned_delivery_user_id = params.actorBusinessUserId;
    } else {
      where.id = { in: [] };
    }
    return;
  }

  if (params.fulfillmentType) {
    where.fulfillment_type = params.fulfillmentType;
  }

  if (params.assignedDeliveryUserId) {
    where.assigned_delivery_user_id = params.assignedDeliveryUserId;
    return;
  }

  if (params.assignment === "assigned") {
    where.assigned_delivery_user_id = { not: null };
  } else if (params.assignment === "unassigned") {
    where.assigned_delivery_user_id = null;
  }
}

export async function listAdminOrders(params: ListAdminOrdersParams) {
  const {
    businessId,
    page,
    pageSize,
    orderId,
    dateFrom,
    dateTo,
    customerPhone,
    fulfillmentType,
    assignment,
    assignedDeliveryUserId,
    actorRole,
    actorBusinessUserId
  } = params;

  const where: Prisma.ordersWhereInput = {
    business_id: businessId
  };

  applyDeliveryAssignmentFilters(where, {
    actorRole,
    actorBusinessUserId,
    fulfillmentType,
    assignment,
    assignedDeliveryUserId
  });

  if (orderId) {
    where.id = orderId;
  }

  if (customerPhone?.trim()) {
    where.customer = {
      phone_number: { contains: customerPhone.trim() }
    };
  }

  if (dateFrom || dateTo) {
    where.created_at = {};
    if (dateFrom) {
      where.created_at.gte = parseDateStart(dateFrom);
    }
    if (dateTo) {
      where.created_at.lte = parseDateEnd(dateTo);
    }
  }

  const skip = (page - 1) * pageSize;

  const [total, rows] = await prisma.$transaction([
    prisma.orders.count({ where }),
    prisma.orders.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: { created_at: "desc" },
      skip,
      take: pageSize
    })
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  return {
    items: rows,
    total,
    page,
    pageSize,
    totalPages
  };
}

export async function getAdminOrderById(businessId: string, orderId: string) {
  const order = await prisma.orders.findFirst({
    where: {
      id: orderId,
      business_id: businessId
    },
    include: ORDER_INCLUDE
  });
  return order;
}

export type UpdateAdminOrderDeliveryStatusResult = {
  order: NonNullable<Awaited<ReturnType<typeof getAdminOrderById>>>;
  customerNotified: boolean;
  notificationReason?: string;
};

/**
 * Actualiza el estado operativo del pedido (entrega) y notifica al cliente por WhatsApp.
 * Si el estado pasa a `delivered` (p. ej. repartidor confirma tras escanear el QR), también
 * marca `payment_status` como `paid` (cobro contra entrega).
 */
export async function updateAdminOrderDeliveryStatus(
  businessId: string,
  orderId: string,
  status: AdminPatchableOrderStatus
): Promise<UpdateAdminOrderDeliveryStatusResult | null> {
  const existing = await prisma.orders.findFirst({
    where: { id: orderId, business_id: businessId },
    include: { customer: { select: { phone_number: true } } }
  });

  if (!existing) {
    return null;
  }

  const markPaidOnDelivery = status === OrderStatus.delivered;

  await prisma.orders.update({
    where: { id: orderId },
    data: markPaidOnDelivery
      ? { status, payment_status: OrderPaymentStatus.paid }
      : { status }
  });

  if (
    markPaidOnDelivery &&
    existing.payment_status !== OrderPaymentStatus.paid
  ) {
    emitAdminOrderPaymentStatusChanged(businessId, {
      orderId,
      payment_status: OrderPaymentStatus.paid
    });
    void notifyAmbassadorSaleIfNeeded(orderId).catch((err) => {
      console.error("[AdminOrders] Error al notificar venta de embajador (cash):", err);
    });
  }

  const notify = await notifyCustomerOrderStatusFromAdmin({
    businessId,
    orderId,
    customerPhone: existing.customer.phone_number,
    conversationId: existing.conversation_id,
    newStatus: status
  });

  emitAdminOrderStatusChanged(businessId, { orderId, status });

  const order = await getAdminOrderById(businessId, orderId);
  if (!order) {
    return null;
  }

  return {
    order,
    customerNotified: notify.sent,
    ...(notify.sent === false ? { notificationReason: notify.reason } : {})
  };
}

export type UpdateAdminOrderPaymentStatusResult = {
  order: NonNullable<Awaited<ReturnType<typeof getAdminOrderById>>>;
};

/**
 * Actualiza solo el cobro (`payment_status`): unpaid | paid.
 */
export async function updateAdminOrderPaymentStatus(
  businessId: string,
  orderId: string,
  payment_status: OrderPaymentStatus
): Promise<UpdateAdminOrderPaymentStatusResult | null> {
  const existing = await prisma.orders.findFirst({
    where: { id: orderId, business_id: businessId }
  });

  if (!existing) {
    return null;
  }

  await prisma.orders.update({
    where: { id: orderId },
    data: { payment_status }
  });

  emitAdminOrderPaymentStatusChanged(businessId, {
    orderId,
    payment_status
  });

  if (payment_status === OrderPaymentStatus.paid && existing.payment_status !== OrderPaymentStatus.paid) {
    void notifyAmbassadorSaleIfNeeded(orderId).catch((err) => {
      console.error("[AdminOrders] Error al notificar venta de embajador (manual/proof):", err);
    });
  }

  const order = await getAdminOrderById(businessId, orderId);
  if (!order) {
    return null;
  }

  return { order };
}
