import {
  KitchenTicketItemStatus,
  OrderPaymentStatus,
  Prisma,
  TabPaymentMethod,
  TabPaymentStatus
} from "@prisma/client";
import { prisma } from "../lib/prisma";
import { acquireTabLock } from "./adminTableTabRound.service";
import { createBillableChargeForAllUnbilledItems } from "./billableCharge.service";
import { triggerAutomaticInvoiceEmissionForBillableCharge } from "./invoicing/invoice.service";

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

/**
 * Saldo total de la cuenta — suma de la deuda de cada una de sus órdenes,
 * menos el descuento manual de cuenta (`table_tab.manual_discount_amount`,
 * ej. "cliente VIP") si lo hay. El descuento se resta UNA vez a nivel
 * agregado acá, nunca por order — `getTableTabOrderDues` sigue devolviendo
 * la deuda real sin descuento (lo usan `listTableTabOrders`/el detalle de
 * "el pedido" para mostrar el desglose real de cada ronda).
 */
export async function getTableTabBalance(
  tx: Prisma.TransactionClient,
  businessId: string,
  tableTabId: string
): Promise<Prisma.Decimal> {
  const dues = await getTableTabOrderDues(tx, businessId, tableTabId);
  const rawBalance = dues.reduce((sum, d) => sum.add(d.due), ZERO);

  const tab = await tx.table_tab.findFirst({
    where: { id: tableTabId, business_id: businessId },
    select: { manual_discount_amount: true }
  });
  const discount = tab?.manual_discount_amount ?? ZERO;
  const discounted = rawBalance.sub(discount);
  return discounted.gt(ZERO) ? discounted : ZERO;
}

/**
 * Distingue "cuenta recién abierta, sin rondas todavía" de "cuenta con
 * órdenes ya pagadas" — ambas tienen saldo $0, pero solo la segunda está
 * "lista para cerrar" (admin, floor-plan en amarillo, §4.F). Sin esto,
 * `getTableTabBalance` devuelve 0 para una mesa recién abierta (sin órdenes)
 * exactamente igual que para una ya pagada, y el frontend no puede
 * distinguirlas.
 */
export async function hasTableTabOrders(
  tx: Prisma.TransactionClient,
  businessId: string,
  tableTabId: string
): Promise<boolean> {
  const row = await tx.orders.findFirst({
    where: { business_id: businessId, table_tab_id: tableTabId },
    select: { id: true }
  });
  return row !== null;
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

/**
 * Fase 7 (§4.E): dispara la facturación consolidada de una cuenta de salón
 * apenas su saldo llega a $0. Siempre fire-and-forget desde el llamador
 * (nunca debe bloquear la respuesta de un pago) — por eso no lanza: cualquier
 * fallo queda contenido y logueado por el propio `triggerAutomaticInvoiceEmissionForBillableCharge`
 * (que nunca lanza) o cae en el `catch` del llamador.
 *
 * Re-chequea el saldo en su propia transacción (puede correr milisegundos
 * después de que otro proceso ya movió la cuenta) antes de crear el cargo —
 * nunca factura una cuenta que, para cuando este hook corrió, ya tiene saldo
 * pendiente de nuevo (ej. se agregó una ronda nueva entre medio).
 */
export async function autoBillAndInvoiceTableTab(businessId: string, tableTabId: string): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    await acquireTabLock(tx, businessId, tableTabId);
    const balance = await getTableTabBalance(tx, businessId, tableTabId);
    if (!balance.lte(ZERO)) {
      return { ok: true, nothingToBill: true } as const;
    }
    return createBillableChargeForAllUnbilledItems(tx, businessId, tableTabId);
  });
  if (!result.ok || "nothingToBill" in result) return;

  await triggerAutomaticInvoiceEmissionForBillableCharge(businessId, result.billableChargeId);
}

// ---------------------------------------------------------------------------
// Registro de pago — DECISIÓN APROBADA §4.D: vuelto dinámico (amount_applied
// nunca excede la deuda real), reparto FIFO por defecto o asignación explícita
// del cajero revalidada servidor-side.
// ---------------------------------------------------------------------------

export type TabPaymentAllocationInput = { orderId: string; amount: Prisma.Decimal };

/**
 * Una línea de cobro por medio (DECISIÓN APROBADA, ampliación de §4.D): un
 * cobro puede partirse entre efectivo/tarjeta/transferencia/QR. Cada línea se
 * persiste como su propia fila `tab_payment` — nunca varios montos en una
 * sola fila — porque cada medio es un hecho físico distinto (cuánto entró de
 * cada uno) que la caja necesita poder reconciliar por separado.
 */
export type TabPaymentLineInput = { method: TabPaymentMethod; amountTendered: Prisma.Decimal };

export type RecordTabPaymentResult =
  | {
      ok: true;
      payments: Array<{
        tabPaymentId: string;
        method: TabPaymentMethod;
        amountTendered: Prisma.Decimal;
        amountApplied: Prisma.Decimal;
        change: Prisma.Decimal;
      }>;
      totalAmountTendered: Prisma.Decimal;
      totalAmountApplied: Prisma.Decimal;
      totalChange: Prisma.Decimal;
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

/**
 * Reparte `totalApplied` (ya validado ≤ Σ capacidades) secuencialmente entre
 * las líneas de cobro, y dentro de cada línea, secuencialmente entre las
 * órdenes de `orderAllocations` — un "merge" de dos colas: se drena la orden
 * actual con la capacidad de la línea actual hasta que una de las dos se
 * agota, y se avanza a la siguiente. El resultado: cada línea recibe su
 * propio subconjunto de aplicaciones que suma exactamente su `amountApplied`,
 * y la unión de todas las líneas para una orden dada suma exactamente la
 * entrada original de `orderAllocations` para esa orden.
 *
 * El vuelto cae por convención en las ÚLTIMAS líneas de la lista (las que
 * quedan con capacidad sin consumir una vez agotadas las órdenes) — por eso
 * el cajero debería poner el efectivo al final si quiere que el vuelto salga
 * de ahí. No hay noción de "vuelto por transferencia" en el mundo real; esta
 * regla es deliberadamente simple, no un intento de resolverlo mejor.
 */
export function splitAllocationsAcrossLines(
  orderAllocations: Array<{ orderId: string; amount: Prisma.Decimal }>,
  lineCapacities: Prisma.Decimal[]
): Array<Array<{ orderId: string; amount: Prisma.Decimal }>> {
  const perLine: Array<Array<{ orderId: string; amount: Prisma.Decimal }>> = lineCapacities.map(
    () => []
  );

  let orderIdx = 0;
  let orderRemaining = orderAllocations[0]?.amount ?? ZERO;

  for (let lineIdx = 0; lineIdx < lineCapacities.length; lineIdx++) {
    let lineRemaining = lineCapacities[lineIdx];
    while (lineRemaining.gt(ZERO) && orderIdx < orderAllocations.length) {
      const take = Prisma.Decimal.min(lineRemaining, orderRemaining);
      if (take.gt(ZERO)) {
        perLine[lineIdx].push({ orderId: orderAllocations[orderIdx].orderId, amount: take });
        lineRemaining = lineRemaining.sub(take);
        orderRemaining = orderRemaining.sub(take);
      }
      if (orderRemaining.lte(ZERO)) {
        orderIdx += 1;
        orderRemaining = orderAllocations[orderIdx]?.amount ?? ZERO;
      }
    }
  }

  return perLine;
}

export async function recordTabPayment(params: {
  businessId: string;
  tableTabId: string;
  /** Una o más líneas de medio de pago — el orden importa para el vuelto (ver `splitAllocationsAcrossLines`). */
  payments: TabPaymentLineInput[];
  /** Si se omite, se reparte FIFO por defecto entre las órdenes con deuda, oldest-first. */
  allocations?: TabPaymentAllocationInput[];
  userId: string;
}): Promise<RecordTabPaymentResult> {
  const { businessId, tableTabId, payments, allocations, userId } = params;

  const totalAmountTendered = payments.reduce((sum, p) => sum.add(p.amountTendered), ZERO);

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
      // el cliente (§4.D). Se valida contra el TOTAL de todas las líneas —
      // partir ese total entre medios es ortogonal a partirlo entre órdenes.
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
      if (allocatedTotal.gt(totalAmountTendered)) {
        return { ok: false, reason: "ALLOCATIONS_EXCEED_AMOUNT_TENDERED" } as const;
      }
      finalAllocations = allocations
        .filter((a) => a.amount.gt(ZERO))
        .map((a) => ({ orderId: a.orderId, amount: a.amount }));
    } else {
      // FIFO por defecto: cubre primero la ronda más antigua con saldo pendiente.
      let remaining = totalAmountTendered.gt(ZERO) ? totalAmountTendered : ZERO;
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

    const totalAmountApplied = finalAllocations.reduce((sum, a) => sum.add(a.amount), ZERO);
    if (totalAmountApplied.lte(ZERO) && totalAmountTendered.lte(ZERO)) {
      return { ok: false, reason: "NOTHING_TO_APPLY" } as const;
    }

    const perLineAllocations = splitAllocationsAcrossLines(
      finalAllocations,
      payments.map((p) => p.amountTendered)
    );

    const createdPayments: Array<{
      tabPaymentId: string;
      method: TabPaymentMethod;
      amountTendered: Prisma.Decimal;
      amountApplied: Prisma.Decimal;
      change: Prisma.Decimal;
    }> = [];

    for (let i = 0; i < payments.length; i++) {
      const line = payments[i];
      const lineAllocations = perLineAllocations[i];
      const lineApplied = lineAllocations.reduce((sum, a) => sum.add(a.amount), ZERO);

      const payment = await tx.tab_payment.create({
        data: {
          business_id: businessId,
          table_tab_id: tableTabId,
          amount_tendered: line.amountTendered,
          amount_applied: lineApplied,
          payment_method: line.method,
          status: TabPaymentStatus.confirmed,
          created_by_user_id: userId,
          applications: {
            create: lineAllocations.map((a) => ({ order_id: a.orderId, amount: a.amount }))
          }
        }
      });

      createdPayments.push({
        tabPaymentId: payment.id,
        method: line.method,
        amountTendered: line.amountTendered,
        amountApplied: lineApplied,
        change: line.amountTendered.sub(lineApplied)
      });
    }

    await reconcileOrderPaymentStatus(
      tx,
      businessId,
      finalAllocations.map((a) => a.orderId)
    );

    return {
      ok: true,
      payments: createdPayments,
      totalAmountTendered,
      totalAmountApplied,
      totalChange: totalAmountTendered.sub(totalAmountApplied),
      allocations: finalAllocations
    } as const;
  }).then((result) => {
    // Fire-and-forget, fuera de la transacción de pago (§4.E): nunca debe
    // demorar ni poder revertir la confirmación del pago en curso.
    if (result.ok) {
      void autoBillAndInvoiceTableTab(businessId, tableTabId).catch((err) => {
        console.error("[Invoicing] Error en auto-facturación de cuenta de salón:", err);
      });
    }
    return result;
  });
}
