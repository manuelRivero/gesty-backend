import { FulfillmentType, OrderPaymentStatus, OrderStatus } from "@prisma/client";
import { assertNever } from "../lib/assertNever";

/**
 * Flujo operativo del pedido (logística). No refleja si el cliente ya pagó.
 * `placed` = pedido confirmado y en cola (antes se llamaba `pending_payment`).
 *
 * Delivery:  placed → preparing → shipped → delivered
 * Take-away: placed → preparing → ready_for_pickup → delivered
 * Dine-in:   placed → preparing → delivered (sin `shipped` ni `ready_for_pickup`,
 *            que son logística de entrega/retiro — no aplican a salón, §4.C)
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

/**
 * Pipeline para rondas de salón (`table_tab_id` seteado): sin `shipped` ni
 * `ready_for_pickup` — ninguno de los dos es logística de salón. El estado
 * granular por producto vive en `kitchen_ticket_item` (Fase 4), fuera de
 * `OrderStatus`; este pipeline es solo el estado comercial grueso de la ronda.
 */
export const DINE_IN_STATUS_PIPELINE: readonly OrderStatus[] = [
  OrderStatus.draft,
  OrderStatus.placed,
  OrderStatus.preparing,
  OrderStatus.delivered
] as const;

/**
 * Resuelve el pipeline de una orden por su `fulfillment_type`, con `switch`
 * exhaustivo: agregar un cuarto valor a `FulfillmentType` sin tocar esta
 * función rompe el build acá (en `default`), en vez de caer en silencio en
 * el pipeline de `DELIVERY` como pasaba con el ternario anterior — ese fue
 * exactamente el riesgo señalado para `DINE_IN` antes de esta Fase 3.
 */
function pipelineForFulfillmentType(
  fulfillmentType: FulfillmentType | null | undefined
): readonly OrderStatus[] {
  if (fulfillmentType == null) {
    // El campo es nullable en el esquema; ningún pedido confirmado debería
    // llegar sin él hoy, pero el tipo lo permite. Se preserva el default
    // implícito que ya tenía el ternario original (pipeline de DELIVERY)
    // en vez de lanzar, para no cambiar comportamiento fuera del alcance
    // de esta Fase.
    return DELIVERY_STATUS_PIPELINE;
  }
  switch (fulfillmentType) {
    case FulfillmentType.TAKE_AWAY:
      return TAKE_AWAY_STATUS_PIPELINE;
    case FulfillmentType.DELIVERY:
      return DELIVERY_STATUS_PIPELINE;
    case FulfillmentType.DINE_IN:
      return DINE_IN_STATUS_PIPELINE;
    default:
      return assertNever(fulfillmentType);
  }
}

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
  const pipeline = pipelineForFulfillmentType(fulfillmentType);
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
