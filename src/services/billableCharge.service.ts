import { BillableChargeStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { acquireTabLock } from "./adminTableTabRound.service";

/**
 * Fase 7 de `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.E`: consolida
 * líneas de una o varias rondas de una `table_tab` en un `billable_charge`,
 * la entidad intermedia hacia `fiscal_invoice` (equivalente, para
 * facturación, de lo que `payment_intent` es para pago — una intención con
 * snapshot, no el resultado). Este servicio NO emite el `fiscal_invoice` en
 * sí (eso es la integración ya existente con Sistemas 360 en
 * `invoice.service.ts`, fuera de este alcance) — solo crea el snapshot y
 * reserva, de forma estricta, la cantidad facturada por línea.
 *
 * Prevención de doble facturación parcial (DECISIÓN APROBADA, §4.E):
 * `billable_charge_line` trackea cuánto de cada `order_item` ya fue
 * facturado. Un `billable_charge` nuevo solo puede tomar la cantidad
 * remanente (`order_item.quantity − Σ quantity_billed` ya confirmada) —
 * consultado siempre por agregación, nunca cacheado.
 */

/**
 * Tercer bloqueo duro de cierre (§4.B/§4.E): ningún `billable_charge` en
 * estado `open` (pendiente de emisión fiscal) sobre la cuenta.
 */
export async function hasOpenBillableCharge(
  tx: Prisma.TransactionClient,
  businessId: string,
  tableTabId: string
): Promise<boolean> {
  const charge = await tx.billable_charge.findFirst({
    where: { business_id: businessId, table_tab_id: tableTabId, status: BillableChargeStatus.open },
    select: { id: true }
  });
  return charge !== null;
}

export type BillableChargeLineInput = { orderItemId: string; quantity: number };

export type CreateBillableChargeResult =
  | { ok: true; billableChargeId: string; amount: Prisma.Decimal }
  | {
      ok: false;
      reason:
        | "TABLE_TAB_NOT_FOUND"
        | "EMPTY_CHARGE"
        | "ORDER_ITEM_NOT_IN_TAB"
        | "QUANTITY_EXCEEDS_REMAINING";
      orderItemId?: string;
    };

export async function createBillableCharge(params: {
  businessId: string;
  tableTabId: string;
  lines: BillableChargeLineInput[];
}): Promise<CreateBillableChargeResult> {
  const { businessId, tableTabId, lines } = params;

  if (lines.length === 0) {
    return { ok: false, reason: "EMPTY_CHARGE" };
  }

  return prisma.$transaction(async (tx) => {
    // Mismo lock de cuenta que el resto de operaciones que mutan la cuenta
    // como entidad (§4.B) — serializa contra cierres/pagos/anulaciones
    // concurrentes sobre la misma `table_tab`.
    await acquireTabLock(tx, businessId, tableTabId);

    const tab = await tx.table_tab.findFirst({ where: { id: tableTabId, business_id: businessId } });
    if (!tab) {
      return { ok: false, reason: "TABLE_TAB_NOT_FOUND" } as const;
    }

    const orderItemIds = [...new Set(lines.map((l) => l.orderItemId))];
    const orderItems = await tx.order_item.findMany({
      where: { id: { in: orderItemIds }, orders: { business_id: businessId, table_tab_id: tableTabId } },
      select: { id: true, quantity: true, unit_price: true, discount_amount: true }
    });
    const orderItemById = new Map(orderItems.map((oi) => [oi.id, oi]));

    const alreadyBilled = await tx.billable_charge_line.findMany({
      where: { order_item_id: { in: orderItemIds } },
      select: { order_item_id: true, quantity_billed: true }
    });
    const billedByOrderItem = new Map<string, number>();
    for (const b of alreadyBilled) {
      billedByOrderItem.set(
        b.order_item_id,
        (billedByOrderItem.get(b.order_item_id) ?? 0) + b.quantity_billed
      );
    }

    let amount = new Prisma.Decimal(0);
    // Acumula lo reservado DENTRO de este mismo request — dos líneas para el
    // mismo order_item en la misma llamada no deben poder superar juntas el
    // remanente, aunque cada una por separado luzca válida.
    const reservedInThisCharge = new Map<string, number>();
    for (const line of lines) {
      const orderItem = orderItemById.get(line.orderItemId);
      if (!orderItem) {
        return { ok: false, reason: "ORDER_ITEM_NOT_IN_TAB", orderItemId: line.orderItemId } as const;
      }
      const remaining = orderItem.quantity - (billedByOrderItem.get(line.orderItemId) ?? 0);
      const alreadyReserved = reservedInThisCharge.get(line.orderItemId) ?? 0;
      if (alreadyReserved + line.quantity > remaining) {
        return {
          ok: false,
          reason: "QUANTITY_EXCEEDS_REMAINING",
          orderItemId: line.orderItemId
        } as const;
      }
      reservedInThisCharge.set(line.orderItemId, alreadyReserved + line.quantity);
      const unitNet = orderItem.unit_price.sub(
        (orderItem.discount_amount ?? new Prisma.Decimal(0)).div(orderItem.quantity)
      );
      amount = amount.add(unitNet.mul(line.quantity));
    }

    const charge = await tx.billable_charge.create({
      data: {
        business_id: businessId,
        table_tab_id: tableTabId,
        amount,
        status: BillableChargeStatus.open,
        lines: {
          create: lines.map((l) => ({ order_item_id: l.orderItemId, quantity_billed: l.quantity }))
        }
      }
    });

    return { ok: true, billableChargeId: charge.id, amount: charge.amount } as const;
  });
}
