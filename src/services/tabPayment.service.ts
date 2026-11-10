import { KitchenTicketItemStatus, OrderPaymentStatus, Prisma, TabPaymentStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { acquireTabLock } from "./adminTableTabRound.service";

/**
 * Fase 6 de `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.D`: ledger de pagos
 * de cuenta (`tab_payment`/`tab_payment_application`) y el saldo derivado que
 * lo acompaña. El saldo NUNCA es un campo cacheado — siempre se recalcula por
 * agregación sobre `orders.total_amount` + `order_item_adjustment` (Fase 4) −
 * `tab_payment_application` confirmadas (§4.D, "Fuente única de verdad
 * económica").
 */

const ZERO = new Prisma.Decimal(0);

export type OrderDue = {
  orderId: string;
  createdAt: Date;
  /** Deuda remanente de ESTA orden/ronda: total efectivo (con adjustments) menos lo ya aplicado. */
  due: Prisma.Decimal;
};

/**
 * Deuda por orden de la cuenta, ordenada por antigüedad (más vieja primero —
 * el orden que el reparto FIFO por defecto necesita). Solo incluye órdenes
 * con `due > 0`; una orden totalmente pagada o totalmente anulada no aparece.
 */
export async function getTableTabOrderDues(
  tx: Prisma.TransactionClient,
  businessId: string,
  tableTabId: string
): Promise<OrderDue[]> {
  const orders = await tx.orders.findMany({
    where: { business_id: businessId, table_tab_id: tableTabId },
    select: { id: true, total_amount: true, created_at: true }
  });
  if (orders.length === 0) {
    return [];
  }
  const orderIds = orders.map((o) => o.id);

  const adjustments = await tx.order_item_adjustment.findMany({
    where: { order_item: { order_id: { in: orderIds } } },
    select: { amount: true, order_item: { select: { order_id: true } } }
  });
  const adjustmentSumByOrder = new Map<string, Prisma.Decimal>();
  for (const a of adjustments) {
    const orderId = a.order_item.order_id;
    adjustmentSumByOrder.set(orderId, (adjustmentSumByOrder.get(orderId) ?? ZERO).add(a.amount));
  }

  const applications = await tx.tab_payment_application.findMany({
    where: { order_id: { in: orderIds }, tab_payment: { status: TabPaymentStatus.confirmed } },
    select: { amount: true, order_id: true }
  });
  const appliedSumByOrder = new Map<string, Prisma.Decimal>();
  for (const ap of applications) {
    appliedSumByOrder.set(ap.order_id, (appliedSumByOrder.get(ap.order_id) ?? ZERO).add(ap.amount));
  }

  return orders
    .map((o) => {
      const effectiveTotal = (o.total_amount ?? ZERO).add(adjustmentSumByOrder.get(o.id) ?? ZERO);
      const applied = appliedSumByOrder.get(o.id) ?? ZERO;
      return { orderId: o.id, createdAt: o.created_at, due: effectiveTotal.sub(applied) };
    })
    .filter((d) => d.due.gt(ZERO))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
}

/** Saldo total de la cuenta — suma de la deuda de cada una de sus órdenes. */
export async function getTableTabBalance(
  tx: Prisma.TransactionClient,
  businessId: string,
  tableTabId: string
): Promise<Prisma.Decimal> {
  const dues = await getTableTabOrderDues(tx, businessId, tableTabId);
  return dues.reduce((sum, d) => sum.add(d.due), ZERO);
}

export async function hasPendingTabPayment(
  tx: Prisma.TransactionClient,
  businessId: string,
  tableTabId: string
): Promise<boolean> {
  const pending = await tx.tab_payment.findFirst({
    where: { business_id: businessId, table_tab_id: tableTabId, status: TabPaymentStatus.pending },
    select: { id: true }
  });
  return pending !== null;
}

/**
 * Advertencia blanda de cierre (§4.B): productos aún no despachados. No
 * bloquea — el llamador decide si procede, mostrando esto al cajero.
 */
export async function hasPendingOrPreparingKitchenItems(
  tx: Prisma.TransactionClient,
  businessId: string,
  tableTabId: string
): Promise<boolean> {
  const item = await tx.kitchen_ticket_item.findFirst({
    where: {
      status: { in: [KitchenTicketItemStatus.pending, KitchenTicketItemStatus.preparing] },
      kitchen_ticket: { order: { business_id: businessId, table_tab_id: tableTabId } }
    },
    select: { id: true }
  });
  return item !== null;
}

/**
 * `OrderPaymentStatus` como proyección de solo lectura del ledger (§4.D,
 * "corregido") — se recalcula cada vez que se escribe una aplicación de pago
 * sobre esa orden, nunca al revés. Solo toca las órdenes recién afectadas por
 * ESTE pago, no toda la cuenta — evita un `UPDATE` innecesario sobre órdenes
 * que esta operación no modificó.
 */
export async function reconcileOrderPaymentStatus(
  tx: Prisma.TransactionClient,
  businessId: string,
  orderIds: string[]
): Promise<void> {
  const uniqueOrderIds = [...new Set(orderIds)];
  if (uniqueOrderIds.length === 0) return;

  const orders = await tx.orders.findMany({
    where: { id: { in: uniqueOrderIds }, business_id: businessId },
    select: { id: true, total_amount: true }
  });

  const adjustments = await tx.order_item_adjustment.findMany({
    where: { order_item: { order_id: { in: uniqueOrderIds } } },
    select: { amount: true, order_item: { select: { order_id: true } } }
  });
  const adjustmentSumByOrder = new Map<string, Prisma.Decimal>();
  for (const a of adjustments) {
    const orderId = a.order_item.order_id;
    adjustmentSumByOrder.set(orderId, (adjustmentSumByOrder.get(orderId) ?? ZERO).add(a.amount));
  }

  const applications = await tx.tab_payment_application.findMany({
    where: { order_id: { in: uniqueOrderIds }, tab_payment: { status: TabPaymentStatus.confirmed } },
    select: { amount: true, order_id: true }
  });
  const appliedSumByOrder = new Map<string, Prisma.Decimal>();
  for (const ap of applications) {
    appliedSumByOrder.set(ap.order_id, (appliedSumByOrder.get(ap.order_id) ?? ZERO).add(ap.amount));
  }

  for (const order of orders) {
    const effectiveTotal = (order.total_amount ?? ZERO).add(adjustmentSumByOrder.get(order.id) ?? ZERO);
    const applied = appliedSumByOrder.get(order.id) ?? ZERO;
    const due = effectiveTotal.sub(applied);
    await tx.orders.update({
      where: { id: order.id },
      data: { payment_status: due.lte(ZERO) ? OrderPaymentStatus.paid : OrderPaymentStatus.unpaid }
    });
  }
}

// ---------------------------------------------------------------------------
// Registro de pago — DECISIÓN APROBADA §4.D: vuelto dinámico (amount_applied
// nunca excede la deuda real), reparto FIFO por defecto o asignación explícita
// del cajero revalidada servidor-side.
// ---------------------------------------------------------------------------

export type TabPaymentAllocationInput = { orderId: string; amount: Prisma.Decimal };

export type RecordTabPaymentResult =
  | {
      ok: true;
      tabPaymentId: string;
      amountTendered: Prisma.Decimal;
      amountApplied: Prisma.Decimal;
      change: Prisma.Decimal;
      allocations: Array<{ orderId: string; amount: Prisma.Decimal }>;
    }
  | {
      ok: false;
      reason:
        | "TABLE_TAB_NOT_FOUND"
        | "NOTHING_TO_APPLY"
        | "ALLOCATION_ORDER_NOT_IN_TAB"
        | "ALLOCATION_EXCEEDS_ORDER_DUE"
        | "ALLOCATIONS_EXCEED_AMOUNT_TENDERED";
      orderId?: string;
    };

export async function recordTabPayment(params: {
  businessId: string;
  tableTabId: string;
  amountTendered: Prisma.Decimal;
  /** Si se omite, se reparte FIFO por defecto entre las órdenes con deuda, oldest-first. */
  allocations?: TabPaymentAllocationInput[];
  userId: string;
}): Promise<RecordTabPaymentResult> {
  const { businessId, tableTabId, amountTendered, allocations, userId } = params;

  return prisma.$transaction(async (tx) => {
    await acquireTabLock(tx, businessId, tableTabId);

    const tab = await tx.table_tab.findFirst({ where: { id: tableTabId, business_id: businessId } });
    if (!tab) {
      return { ok: false, reason: "TABLE_TAB_NOT_FOUND" } as const;
    }

    const dues = await getTableTabOrderDues(tx, businessId, tableTabId);
    const dueByOrder = new Map(dues.map((d) => [d.orderId, d.due]));

    let finalAllocations: Array<{ orderId: string; amount: Prisma.Decimal }>;

    if (allocations && allocations.length > 0) {
      // Asignación explícita del cajero — revalidada servidor-side contra la
      // deuda REAL de cada orden, nunca confiando en un reparto calculado en
      // el cliente (§4.D).
      let allocatedTotal = ZERO;
      for (const a of allocations) {
        const due = dueByOrder.get(a.orderId);
        if (due === undefined) {
          return { ok: false, reason: "ALLOCATION_ORDER_NOT_IN_TAB", orderId: a.orderId } as const;
        }
        if (a.amount.gt(due)) {
          return { ok: false, reason: "ALLOCATION_EXCEEDS_ORDER_DUE", orderId: a.orderId } as const;
        }
        allocatedTotal = allocatedTotal.add(a.amount);
      }
      if (allocatedTotal.gt(amountTendered)) {
        return { ok: false, reason: "ALLOCATIONS_EXCEED_AMOUNT_TENDERED" } as const;
      }
      finalAllocations = allocations
        .filter((a) => a.amount.gt(ZERO))
        .map((a) => ({ orderId: a.orderId, amount: a.amount }));
    } else {
      // FIFO por defecto: cubre primero la ronda más antigua con saldo pendiente.
      let remaining = amountTendered.gt(ZERO) ? amountTendered : ZERO;
      finalAllocations = [];
      for (const d of dues) {
        if (remaining.lte(ZERO)) break;
        const take = Prisma.Decimal.min(remaining, d.due);
        if (take.gt(ZERO)) {
          finalAllocations.push({ orderId: d.orderId, amount: take });
          remaining = remaining.sub(take);
        }
      }
    }

    const amountApplied = finalAllocations.reduce((sum, a) => sum.add(a.amount), ZERO);
    if (amountApplied.lte(ZERO) && amountTendered.lte(ZERO)) {
      return { ok: false, reason: "NOTHING_TO_APPLY" } as const;
    }

    const payment = await tx.tab_payment.create({
      data: {
        business_id: businessId,
        table_tab_id: tableTabId,
        amount_tendered: amountTendered,
        amount_applied: amountApplied,
        status: TabPaymentStatus.confirmed,
        created_by_user_id: userId,
        applications: {
          create: finalAllocations.map((a) => ({ order_id: a.orderId, amount: a.amount }))
        }
      }
    });

    await reconcileOrderPaymentStatus(
      tx,
      businessId,
      finalAllocations.map((a) => a.orderId)
    );

    return {
      ok: true,
      tabPaymentId: payment.id,
      amountTendered,
      amountApplied,
      change: amountTendered.sub(amountApplied),
      allocations: finalAllocations
    } as const;
  });
}
