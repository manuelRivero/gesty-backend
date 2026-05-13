import { FulfillmentType, OrderPaymentStatus, OrderStatus } from "@prisma/client";

/**
 * Flujo operativo del pedido (logística). No refleja si el cliente ya pagó.
 * `placed` = pedido confirmado y en cola (antes se llamaba `pending_payment`).
 *
 * Delivery:  placed → preparing → shipped → delivered
 * Take-away: placed → preparing → ready_for_pickup → delivered
 */
export const ORDER_STATUS_PIPELINE: readonly OrderStatus[] = [
  OrderStatus.draft,
  OrderStatus.placed,
  OrderStatus.preparing,
  OrderStatus.ready_for_pickup,
  OrderStatus.shipped,
  OrderStatus.delivered
] as const;

/** Pipeline para pedidos de tipo take-away (saltea `shipped`). */
export const TAKE_AWAY_STATUS_PIPELINE: readonly OrderStatus[] = [
  OrderStatus.draft,
  OrderStatus.placed,
  OrderStatus.preparing,
  OrderStatus.ready_for_pickup,
  OrderStatus.delivered
] as const;

/** Pipeline para pedidos de tipo delivery (saltea `ready_for_pickup`). */
export const DELIVERY_STATUS_PIPELINE: readonly OrderStatus[] = [
  OrderStatus.draft,
  OrderStatus.placed,
  OrderStatus.preparing,
  OrderStatus.shipped,
  OrderStatus.delivered
] as const;

/** Estados que el panel puede asignar vía PATCH /api/admin/orders/:id/status */
export const ADMIN_PATCHABLE_ORDER_STATUSES = [
  OrderStatus.preparing,
  OrderStatus.ready_for_pickup,
  OrderStatus.shipped,
  OrderStatus.delivered
] as const;

export type AdminPatchableOrderStatus =
  (typeof ADMIN_PATCHABLE_ORDER_STATUSES)[number];

export function isAdminPatchableOrderStatus(
  value: string
): value is AdminPatchableOrderStatus {
  return (ADMIN_PATCHABLE_ORDER_STATUSES as readonly string[]).includes(value);
}

/**
 * Siguiente estado en el pipeline según el tipo de entrega del pedido,
 * o `null` si ya es el último o es `cancelled`.
 */
export function getNextOrderStatus(
  current: OrderStatus,
  fulfillmentType?: FulfillmentType | null
): OrderStatus | null {
  if (current === OrderStatus.cancelled) {
    return null;
  }
  const pipeline =
    fulfillmentType === FulfillmentType.TAKE_AWAY
      ? TAKE_AWAY_STATUS_PIPELINE
      : DELIVERY_STATUS_PIPELINE;
  const i = pipeline.indexOf(current);
  if (i === -1 || i >= pipeline.length - 1) {
    return null;
  }
  return pipeline[i + 1]!;
}

/** Etiquetas en español para el estado operativo (UI admin). */
export const ORDER_STATUS_LABEL_ES: Record<OrderStatus, string> = {
  [OrderStatus.draft]: "Borrador",
  [OrderStatus.placed]: "Pedido recibido",
  [OrderStatus.preparing]: "En preparación",
  [OrderStatus.ready_for_pickup]: "Listo para retirar",
  [OrderStatus.shipped]: "Enviado",
  [OrderStatus.delivered]: "Entregado",
  [OrderStatus.cancelled]: "Cancelado"
};

/** Etiquetas para el cobro (independiente de la logística). */
export const ORDER_PAYMENT_STATUS_LABEL_ES: Record<OrderPaymentStatus, string> = {
  [OrderPaymentStatus.unpaid]: "Sin cobrar",
  [OrderPaymentStatus.paid]: "Cobrado"
};
