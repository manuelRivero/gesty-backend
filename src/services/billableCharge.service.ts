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
  if (params.lines.length === 0) {
    return { ok: false, reason: "EMPTY_CHARGE" };
  }
  return prisma.$transaction((tx) => createBillableChargeInTx(tx, params));
}

/**
 * Cuerpo real de `createBillableCharge`, parametrizado por `tx` para poder
 * componerse dentro de una transacción ya abierta por el llamador (cierre de
 * cuenta, auto-facturación post-pago) sin anidar `prisma.$transaction`.
 */
export async function createBillableChargeInTx(
  tx: Prisma.TransactionClient,
  params: { businessId: string; tableTabId: string; lines: BillableChargeLineInput[] }
): Promise<CreateBillableChargeResult> {
  const { businessId, tableTabId, lines } = params;

  if (lines.length === 0) {
    return { ok: false, reason: "EMPTY_CHARGE" };
  }

  // Mismo lock de cuenta que el resto de operaciones que mutan la cuenta
  // como entidad (§4.B) — serializa contra cierres/pagos/anulaciones
  // concurrentes sobre la misma `table_tab`. Re-entrante dentro de la misma
  // transacción (advisory lock a nivel de sesión/xact), así que es seguro
  // llamarlo aunque el `tx` recibido ya lo haya adquirido antes.
  await acquireTabLock(tx, businessId, tableTabId);

  const tab = await tx.table_tab.findFirst({ where: { id: tableTabId, business_id: businessId } });
  if (!tab) {
    return { ok: false, reason: "TABLE_TAB_NOT_FOUND" };
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
      return { ok: false, reason: "ORDER_ITEM_NOT_IN_TAB", orderItemId: line.orderItemId };
    }
    const remaining = orderItem.quantity - (billedByOrderItem.get(line.orderItemId) ?? 0);
    const alreadyReserved = reservedInThisCharge.get(line.orderItemId) ?? 0;
    if (alreadyReserved + line.quantity > remaining) {
      return { ok: false, reason: "QUANTITY_EXCEEDS_REMAINING", orderItemId: line.orderItemId };
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

  return { ok: true, billableChargeId: charge.id, amount: charge.amount };
}

export type CreateBillableChargeForAllUnbilledItemsResult =
  | { ok: true; billableChargeId: string; amount: Prisma.Decimal }
  | { ok: true; nothingToBill: true }
  | { ok: false; reason: "TABLE_TAB_NOT_FOUND" };

/**
 * Variante automática de `createBillableCharge`: en vez de que el caller
 * especifique las líneas, calcula el remanente sin facturar de TODOS los
 * `order_item` de la cuenta (todas las rondas) y consolida ese remanente en
 * un único `billable_charge` — el disparo post-pago/pre-cierre (§4.E).
 * Devuelve `{ ok: true; nothingToBill: true }`, no un error, cuando no queda
 * nada por facturar (mesa sin consumo, o ya todo facturado antes).
 */
export async function createBillableChargeForAllUnbilledItems(
  tx: Prisma.TransactionClient,
  businessId: string,
  tableTabId: string
): Promise<CreateBillableChargeForAllUnbilledItemsResult> {
  const tab = await tx.table_tab.findFirst({ where: { id: tableTabId, business_id: businessId } });
  if (!tab) {
    return { ok: false, reason: "TABLE_TAB_NOT_FOUND" };
  }

  const orderItems = await tx.order_item.findMany({
    where: { orders: { business_id: businessId, table_tab_id: tableTabId } },
    select: { id: true, quantity: true }
  });
  if (orderItems.length === 0) {
    return { ok: true, nothingToBill: true };
  }
  const orderItemIds = orderItems.map((oi) => oi.id);

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

  const lines: BillableChargeLineInput[] = [];
  for (const item of orderItems) {
    const remaining = item.quantity - (billedByOrderItem.get(item.id) ?? 0);
    if (remaining > 0) {
      lines.push({ orderItemId: item.id, quantity: remaining });
    }
  }
  if (lines.length === 0) {
    return { ok: true, nothingToBill: true };
  }

  const result = await createBillableChargeInTx(tx, { businessId, tableTabId, lines });
  if (!result.ok) {
    // No debería pasar — las líneas se calcularon a partir de la deuda real
    // en esta misma consulta — pero si hay una condición de carrera real, se
    // propaga como "nada que hacer" en vez de un error duro: quien llama a
    // esta función (auto-facturación) nunca debe bloquear el pago/cierre.
    return { ok: true, nothingToBill: true };
  }
  return result;
}
