import { OrderPaymentStatus, OrderStatus } from "@prisma/client";

/**
 * Flujo operativo del pedido (logística). No refleja si el cliente ya pagó.
 * `placed` = pedido confirmado y en cola (antes se llamaba `pending_payment`).
 */
export const ORDER_STATUS_PIPELINE: readonly OrderStatus[] = [
  OrderStatus.draft,
  OrderStatus.placed,
  OrderStatus.preparing,
  OrderStatus.shipped,
  OrderStatus.delivered
] as const;

/** Estados que el panel puede asignar vía PATCH /api/admin/orders/:id/status */
export const ADMIN_PATCHABLE_ORDER_STATUSES = [
  OrderStatus.preparing,
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
 * Siguiente estado en el pipeline lineal, o `null` si ya es el último o es `cancelled`.
 */
export function getNextOrderStatus(current: OrderStatus): OrderStatus | null {
  if (current === OrderStatus.cancelled) {
    return null;
  }
  const i = ORDER_STATUS_PIPELINE.indexOf(current);
  if (i === -1 || i >= ORDER_STATUS_PIPELINE.length - 1) {
    return null;
  }
  return ORDER_STATUS_PIPELINE[i + 1]!;
}

/** Etiquetas en español para el estado operativo (UI admin). */
export const ORDER_STATUS_LABEL_ES: Record<OrderStatus, string> = {
  [OrderStatus.draft]: "Borrador",
  [OrderStatus.placed]: "Pedido recibido",
  [OrderStatus.preparing]: "En preparación",
  [OrderStatus.shipped]: "Enviado",
  [OrderStatus.delivered]: "Entregado",
  [OrderStatus.cancelled]: "Cancelado"
};

/** Etiquetas para el cobro (independiente de la logística). */
export const ORDER_PAYMENT_STATUS_LABEL_ES: Record<OrderPaymentStatus, string> = {
  [OrderPaymentStatus.unpaid]: "Sin cobrar",
  [OrderPaymentStatus.paid]: "Cobrado"
};
