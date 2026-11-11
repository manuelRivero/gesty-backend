import { describe, expect, it, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../adminTableTabRound.service", () => ({
  acquireTabLock: vi.fn().mockResolvedValue(undefined),
}));

import { createBillableChargeForAllUnbilledItems } from "../billableCharge.service";

const BUSINESS_ID = "biz-1";
const TABLE_TAB_ID = "tab-1";

function makeTx(overrides: {
  orderItems?: Array<{ id: string; quantity: number; unit_price: Prisma.Decimal; discount_amount: Prisma.Decimal | null }>;
  billedLines?: Array<{ order_item_id: string; quantity_billed: number }>;
  manualDiscountAmount?: Prisma.Decimal;
  manualDiscountAppliedToInvoice?: boolean;
}) {
  const orderItems = overrides.orderItems ?? [];
  const billedLines = overrides.billedLines ?? [];
  const create = vi.fn().mockImplementation(({ data }: { data: { amount: Prisma.Decimal } }) =>
    Promise.resolve({ id: "charge-1", amount: data.amount })
  );
  const tableTabUpdate = vi.fn().mockResolvedValue({ id: TABLE_TAB_ID });
  const tx = {
    table_tab: {
      findFirst: vi.fn().mockResolvedValue({
        id: TABLE_TAB_ID,
        manual_discount_amount: overrides.manualDiscountAmount ?? new Prisma.Decimal(0),
        manual_discount_applied_to_invoice: overrides.manualDiscountAppliedToInvoice ?? false,
      }),
      update: tableTabUpdate,
    },
    order_item: {
      // Usada por `createBillableChargeForAllUnbilledItems` (select: {id, quantity})
      // y por `createBillableChargeInTx` (select amplio, filtrado por `id: {in}`).
      findMany: vi.fn().mockImplementation(({ where }: { where: { id?: { in: string[] } } }) => {
        if (where.id) {
          return Promise.resolve(orderItems.filter((oi) => where.id!.in.includes(oi.id)));
        }
        return Promise.resolve(orderItems);
      }),
    },
    billable_charge_line: {
      findMany: vi.fn().mockResolvedValue(billedLines),
    },
    billable_charge: {
      create,
    },
  };
  return { tx, create, tableTabUpdate };
}

describe("createBillableChargeForAllUnbilledItems", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("consolida solo el remanente sin facturar de cada order_item", async () => {
    const { tx, create } = makeTx({
      orderItems: [
        { id: "oi-a", quantity: 5, unit_price: new Prisma.Decimal(100), discount_amount: null },
        { id: "oi-b", quantity: 2, unit_price: new Prisma.Decimal(50), discount_amount: null },
      ],
      billedLines: [
        { order_item_id: "oi-a", quantity_billed: 2 },
        { order_item_id: "oi-b", quantity_billed: 2 },
      ],
    });

    const result = await createBillableChargeForAllUnbilledItems(tx as any, BUSINESS_ID, TABLE_TAB_ID);

    expect(result.ok).toBe(true);
    if (!result.ok || "nothingToBill" in result) throw new Error("esperaba un charge creado");
    expect(result.billableChargeId).toBe("charge-1");
    // oi-a: remanente 3 * 100 = 300 (oi-b sin remanente, excluido).
    expect(result.amount.toNumber()).toBe(300);
    expect(create).toHaveBeenCalledTimes(1);
    const callArg = create.mock.calls[0][0];
    expect(callArg.data.lines.create).toEqual([{ order_item_id: "oi-a", quantity_billed: 3 }]);
  });

  it("no crea nada cuando todo ya fue facturado", async () => {
    const { tx, create } = makeTx({
      orderItems: [{ id: "oi-a", quantity: 3, unit_price: new Prisma.Decimal(100), discount_amount: null }],
      billedLines: [{ order_item_id: "oi-a", quantity_billed: 3 }],
    });

    const result = await createBillableChargeForAllUnbilledItems(tx as any, BUSINESS_ID, TABLE_TAB_ID);

    expect(result).toEqual({ ok: true, nothingToBill: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("no crea nada cuando la cuenta no tiene ninguna orden", async () => {
    const { tx, create } = makeTx({ orderItems: [] });

    const result = await createBillableChargeForAllUnbilledItems(tx as any, BUSINESS_ID, TABLE_TAB_ID);

    expect(result).toEqual({ ok: true, nothingToBill: true });
    expect(create).not.toHaveBeenCalled();
  });

  it("descuenta el descuento prorrateado al calcular el monto del remanente", async () => {
    const { tx } = makeTx({
      orderItems: [
        { id: "oi-a", quantity: 4, unit_price: new Prisma.Decimal(100), discount_amount: new Prisma.Decimal(40) },
      ],
      billedLines: [],
    });

    const result = await createBillableChargeForAllUnbilledItems(tx as any, BUSINESS_ID, TABLE_TAB_ID);

    expect(result.ok).toBe(true);
    if (!result.ok || "nothingToBill" in result) throw new Error("esperaba un charge creado");
    // unitNet = 100 - (40/4) = 90; remanente completo (4) => 360.
    expect(result.amount.toNumber()).toBe(360);
  });
});

describe("createBillableChargeForAllUnbilledItems — descuento manual de cuenta (VIP)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resta el descuento manual del monto final y marca manual_discount_applied_to_invoice", async () => {
    const { tx, create, tableTabUpdate } = makeTx({
      orderItems: [{ id: "oi-a", quantity: 2, unit_price: new Prisma.Decimal(100), discount_amount: null }],
      billedLines: [],
      manualDiscountAmount: new Prisma.Decimal(50),
      manualDiscountAppliedToInvoice: false,
    });

    const result = await createBillableChargeForAllUnbilledItems(tx as any, BUSINESS_ID, TABLE_TAB_ID);

    expect(result.ok).toBe(true);
    if (!result.ok || "nothingToBill" in result) throw new Error("esperaba un charge creado");
    // Crudo: 200. Descuento: 50. Final: 150.
    expect(result.amount.toNumber()).toBe(150);
    const callArg = create.mock.calls[0][0];
    expect(callArg.data.manual_discount_applied.toNumber()).toBe(50);
    expect(tableTabUpdate).toHaveBeenCalledWith({
      where: { id: TABLE_TAB_ID },
      data: { manual_discount_applied_to_invoice: true },
    });
  });

  it("NUNCA resta el descuento dos veces, aunque se llame dos veces seguidas", async () => {
    const { tx, create, tableTabUpdate } = makeTx({
      orderItems: [
        { id: "oi-a", quantity: 1, unit_price: new Prisma.Decimal(100), discount_amount: null },
        { id: "oi-b", quantity: 1, unit_price: new Prisma.Decimal(100), discount_amount: null },
      ],
      billedLines: [{ order_item_id: "oi-a", quantity_billed: 1 }],
      manualDiscountAmount: new Prisma.Decimal(30),
      // Simula que una llamada anterior YA aplicó el descuento a otro billable_charge.
      manualDiscountAppliedToInvoice: true,
    });

    const result = await createBillableChargeForAllUnbilledItems(tx as any, BUSINESS_ID, TABLE_TAB_ID);

    expect(result.ok).toBe(true);
    if (!result.ok || "nothingToBill" in result) throw new Error("esperaba un charge creado");
    // Solo oi-b tiene remanente (100) — SIN restar el descuento de nuevo.
    expect(result.amount.toNumber()).toBe(100);
    expect(create.mock.calls[0][0].data.manual_discount_applied.toNumber()).toBe(0);
    expect(tableTabUpdate).not.toHaveBeenCalled();
  });

  it("nunca deja el monto negativo si el descuento manual supera el remanente de este cargo puntual", async () => {
    const { tx, create } = makeTx({
      orderItems: [{ id: "oi-a", quantity: 1, unit_price: new Prisma.Decimal(50), discount_amount: null }],
      billedLines: [],
      manualDiscountAmount: new Prisma.Decimal(80),
      manualDiscountAppliedToInvoice: false,
    });

    const result = await createBillableChargeForAllUnbilledItems(tx as any, BUSINESS_ID, TABLE_TAB_ID);

    expect(result.ok).toBe(true);
    if (!result.ok || "nothingToBill" in result) throw new Error("esperaba un charge creado");
    expect(result.amount.toNumber()).toBe(0);
    expect(create.mock.calls[0][0].data.manual_discount_applied.toNumber()).toBe(50);
  });
});
