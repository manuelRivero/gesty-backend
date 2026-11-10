import { KitchenTicketItemStatus, OrderItemAdjustmentReason, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { tabLockKey, acquireTabLock } from "./adminTableTabRound.service";
import { emitAdminKitchenTicketItemStatusChanged } from "../socket/adminSocket";
import { reconcileOrderPaymentStatus } from "./tabPayment.service";
import type { BusinessUserRole } from "../types/auth";

/**
 * Fase 4 de `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.C`: transición de
 * estado de comanda (`advanceKitchenTicketItemStatus`) y anulación de un ítem
 * ya confirmado desde el salón (`cancelOrderItem`). El estado de
 * `kitchen_ticket_item` es una máquina de estados puramente operativa de
 * cocina — ninguna de las dos funciones toca `orders.status`.
 */

// ---------------------------------------------------------------------------
// Transición de estado de comanda: pending -> preparing -> ready.
// La anulación (-> canceled) tiene su propio camino, `cancelOrderItem`, porque
// tiene reglas de rol/motivo que la transición normal no tiene.
// ---------------------------------------------------------------------------

const FORWARD_TRANSITIONS: Record<"preparing" | "ready", KitchenTicketItemStatus> = {
  preparing: KitchenTicketItemStatus.pending,
  ready: KitchenTicketItemStatus.preparing
};

export type AdvanceKitchenTicketItemStatusResult =
  | { ok: true; id: string; status: KitchenTicketItemStatus }
  | {
      ok: false;
      reason: "NOT_FOUND" | "INVALID_TRANSITION" | "CONCURRENT_UPDATE";
      currentStatus?: KitchenTicketItemStatus;
    };

/**
 * Avanza `kitchen_ticket_item.status` un paso (`pending -> preparing` o
 * `preparing -> ready`), dentro de una transacción: lee el estado vigente,
 * aplica un `UPDATE ... WHERE status = <esperado>` atómico (compare-and-swap —
 * si otra transición concurrente ya corrió, el `count` da 0 y se reporta en
 * vez de pisarla silenciosamente) y registra el evento correspondiente.
 */
export async function advanceKitchenTicketItemStatus(params: {
  businessId: string;
  kitchenTicketItemId: string;
  toStatus: "preparing" | "ready";
  userId: string;
}): Promise<AdvanceKitchenTicketItemStatusResult> {
  const { businessId, kitchenTicketItemId, toStatus, userId } = params;
  const expectedFrom = FORWARD_TRANSITIONS[toStatus];

  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.kitchen_ticket_item.findFirst({
      where: { id: kitchenTicketItemId, kitchen_ticket: { order: { business_id: businessId } } },
      select: {
        id: true,
        status: true,
        kitchen_ticket: { select: { id: true, order_id: true, station_id: true } }
      }
    });
    if (!current) {
      return { ok: false, reason: "NOT_FOUND" } as const;
    }
    if (current.status !== expectedFrom) {
      return { ok: false, reason: "INVALID_TRANSITION", currentStatus: current.status } as const;
    }

    const cas = await tx.kitchen_ticket_item.updateMany({
      where: { id: current.id, status: expectedFrom },
      data: { status: toStatus }
    });
    if (cas.count === 0) {
      return { ok: false, reason: "CONCURRENT_UPDATE" } as const;
    }

    await tx.kitchen_ticket_item_event.create({
      data: {
        kitchen_ticket_item_id: current.id,
        from_status: expectedFrom,
        to_status: toStatus,
        created_by_user_id: userId
      }
    });

    return {
      ok: true,
      id: current.id,
      status: toStatus as KitchenTicketItemStatus,
      fromStatus: expectedFrom,
      kitchenTicketId: current.kitchen_ticket.id,
      orderId: current.kitchen_ticket.order_id,
      stationId: current.kitchen_ticket.station_id
    } as const;
  });

  if (result.ok) {
    emitAdminKitchenTicketItemStatusChanged(businessId, {
      kitchenTicketItemId: result.id,
      kitchenTicketId: result.kitchenTicketId,
      stationId: result.stationId,
      orderId: result.orderId,
      fromStatus: result.fromStatus,
      toStatus: result.status
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Anulación de un order_item desde el salón — POS_TECHNICAL_DESIGN.md §4.C,
// "DECISIÓN APROBADA — anulación de productos y su impacto económico" + la
// matriz de roles aprobada a continuación de esa decisión:
//   - kitchen_ticket_item en `pending` (o sin estación asignada): cualquier rol
//     operativo (STAFF/ADMIN/OWNER) puede anular, sin motivo.
//   - kitchen_ticket_item en `preparing`/`ready`: exige rol ADMIN/OWNER y un
//     motivo estructurado (merma/anulación con costo hundido).
// ---------------------------------------------------------------------------

const ELEVATED_ROLES: ReadonlySet<BusinessUserRole> = new Set(["ADMIN", "OWNER"]);

export type CancelOrderItemResult =
  | { ok: true; adjustmentId: string; amount: Prisma.Decimal }
  | {
      ok: false;
      reason:
        | "ORDER_ITEM_NOT_FOUND"
        | "ALREADY_CANCELED"
        | "ROLE_NOT_ALLOWED"
        | "REASON_REQUIRED"
        | "CONCURRENT_STATUS_CHANGE";
    };

export async function cancelOrderItem(params: {
  businessId: string;
  tableTabId: string;
  orderItemId: string;
  userId: string;
  userRole: BusinessUserRole;
  reason?: OrderItemAdjustmentReason;
}): Promise<CancelOrderItemResult> {
  const { businessId, tableTabId, orderItemId, userId, userRole, reason } = params;

  const result = await prisma.$transaction(async (tx) => {
    await acquireTabLock(tx, businessId, tableTabId);

    const orderItem = await tx.order_item.findFirst({
      where: {
        id: orderItemId,
        orders: { business_id: businessId, table_tab_id: tableTabId }
      },
      include: {
        kitchen_ticket_item: {
          include: { kitchen_ticket: { select: { id: true, order_id: true, station_id: true } } }
        }
      }
    });
    if (!orderItem) {
      return { ok: false, reason: "ORDER_ITEM_NOT_FOUND" } as const;
    }

    const ticketItem = orderItem.kitchen_ticket_item;
    if (ticketItem?.status === KitchenTicketItemStatus.canceled) {
      return { ok: false, reason: "ALREADY_CANCELED" } as const;
    }

    // Sin `kitchen_ticket_item` (menu_item sin estación asignada) se trata como
    // `pending`: nunca hubo preparación, así que no hay costo hundido que auditar.
    const currentKitchenStatus = ticketItem?.status ?? KitchenTicketItemStatus.pending;
    const requiresElevation =
      currentKitchenStatus === KitchenTicketItemStatus.preparing ||
      currentKitchenStatus === KitchenTicketItemStatus.ready;

    if (requiresElevation) {
      if (!ELEVATED_ROLES.has(userRole)) {
        return { ok: false, reason: "ROLE_NOT_ALLOWED" } as const;
      }
      if (!reason) {
        return { ok: false, reason: "REASON_REQUIRED" } as const;
      }
    }

    let ticketEventId: string | null = null;
    if (ticketItem) {
      // Compare-and-swap: el estado leído arriba pudo quedar desactualizado si
      // cocina avanzó el ítem justo en este instante. Si el `count` da 0, la
      // decisión de rol/motivo recién tomada ya no es válida sobre el estado
      // real — se reporta en vez de anular con una autorización obsoleta.
      const cas = await tx.kitchen_ticket_item.updateMany({
        where: { id: ticketItem.id, status: currentKitchenStatus },
        data: { status: KitchenTicketItemStatus.canceled }
      });
      if (cas.count === 0) {
        return { ok: false, reason: "CONCURRENT_STATUS_CHANGE" } as const;
      }

      const event = await tx.kitchen_ticket_item_event.create({
        data: {
          kitchen_ticket_item_id: ticketItem.id,
          from_status: currentKitchenStatus,
          to_status: KitchenTicketItemStatus.canceled,
          created_by_user_id: userId
        }
      });
      ticketEventId = event.id;
    }

    const lineTotal = orderItem.unit_price
      .mul(orderItem.quantity)
      .sub(orderItem.discount_amount ?? new Prisma.Decimal(0));

    const adjustment = await tx.order_item_adjustment.create({
      data: {
        order_item_id: orderItem.id,
        amount: lineTotal.negated(),
        reason: requiresElevation ? reason! : null,
        requested_by_user_id: userId,
        kitchen_ticket_item_event_id: ticketEventId
      }
    });

    // La anulación reduce la deuda efectiva de la orden (§4.D) — puede hacer
    // que una orden ya cubierta por pagos previos pase a `paid` recién ahora.
    await reconcileOrderPaymentStatus(tx, businessId, [orderItem.order_id]);

    return {
      ok: true,
      adjustmentId: adjustment.id,
      amount: adjustment.amount,
      canceledTicketItem: ticketItem
        ? {
            kitchenTicketItemId: ticketItem.id,
            kitchenTicketId: ticketItem.kitchen_ticket.id,
            orderId: ticketItem.kitchen_ticket.order_id,
            stationId: ticketItem.kitchen_ticket.station_id,
            fromStatus: currentKitchenStatus
          }
        : null
    } as const;
  });

  if (result.ok && result.canceledTicketItem) {
    const t = result.canceledTicketItem;
    emitAdminKitchenTicketItemStatusChanged(businessId, {
      kitchenTicketItemId: t.kitchenTicketItemId,
      kitchenTicketId: t.kitchenTicketId,
      stationId: t.stationId,
      orderId: t.orderId,
      fromStatus: t.fromStatus,
      toStatus: KitchenTicketItemStatus.canceled
    });
  }

  return result;
}
