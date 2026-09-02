import { FulfillmentType, OrderStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { getAdminOrderById } from "./adminOrders.service";

export type OrderDeliveryAssignmentCode =
  | "NOT_FOUND"
  | "NOT_DELIVERY_USER"
  | "ORDER_NOT_DELIVERY"
  | "ORDER_ALREADY_DELIVERED";

export class OrderDeliveryAssignmentError extends Error {
  readonly code: OrderDeliveryAssignmentCode;

  constructor(code: OrderDeliveryAssignmentCode, message: string) {
    super(message);
    this.name = "OrderDeliveryAssignmentError";
    this.code = code;
  }
}

type OrderAccessFields = {
  assigned_delivery_user_id: string | null;
  fulfillment_type: FulfillmentType | null;
};

export function canDeliveryAccessOrder(params: {
  order: OrderAccessFields;
  actorBusinessUserId: string;
}): boolean {
  return (
    params.order.fulfillment_type === FulfillmentType.DELIVERY &&
    params.order.assigned_delivery_user_id === params.actorBusinessUserId
  );
}

export async function assertAssignableDeliveryUser(params: {
  businessId: string;
  businessUserId: string;
}): Promise<void> {
  const row = await prisma.business_user.findFirst({
    where: {
      id: params.businessUserId,
      business_id: params.businessId,
      role: "DELIVERY"
    },
    select: { id: true }
  });

  if (!row) {
    throw new OrderDeliveryAssignmentError(
      "NOT_DELIVERY_USER",
      "El usuario indicado no es un repartidor de este negocio"
    );
  }
}

function assertOrderAssignable(order: {
  fulfillment_type: FulfillmentType | null;
  status: OrderStatus;
}): void {
  if (order.status === OrderStatus.delivered) {
    throw new OrderDeliveryAssignmentError(
      "ORDER_ALREADY_DELIVERED",
      "No se puede cambiar la asignación de un pedido ya entregado"
    );
  }
}

export async function assignOrderDelivery(params: {
  businessId: string;
  orderId: string;
  assignedDeliveryUserId: string | null;
}) {
  const existing = await prisma.orders.findFirst({
    where: {
      id: params.orderId,
      business_id: params.businessId
    },
    select: {
      id: true,
      status: true,
      fulfillment_type: true
    }
  });

  if (!existing) {
    throw new OrderDeliveryAssignmentError(
      "NOT_FOUND",
      "Orden no encontrada"
    );
  }

  assertOrderAssignable(existing);

  if (params.assignedDeliveryUserId !== null) {
    if (existing.fulfillment_type !== FulfillmentType.DELIVERY) {
      throw new OrderDeliveryAssignmentError(
        "ORDER_NOT_DELIVERY",
        "Solo se pueden asignar pedidos de envío a domicilio"
      );
    }
    await assertAssignableDeliveryUser({
      businessId: params.businessId,
      businessUserId: params.assignedDeliveryUserId
    });
  }

  await prisma.orders.update({
    where: { id: params.orderId },
    data: {
      assigned_delivery_user_id: params.assignedDeliveryUserId
    }
  });

  const order = await getAdminOrderById(params.businessId, params.orderId);
  if (!order) {
    throw new OrderDeliveryAssignmentError(
      "NOT_FOUND",
      "Orden no encontrada"
    );
  }

  return order;
}
