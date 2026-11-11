import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    billable_charge: { findUnique: vi.fn() },
    billable_charge_line: { findMany: vi.fn() },
  },
}));

import { prisma } from "../../../lib/prisma";
import { buildLineItemsForBillableCharge } from "../invoice.service";

function mockLines(
  lines: Array<{ unitPrice: number; quantity: number; discount?: number; name?: string }>
) {
  (prisma.billable_charge_line.findMany as any).mockResolvedValue(
    lines.map((l, i) => ({
      quantity_billed: l.quantity,
      order_item: {
        unit_price: new Prisma.Decimal(l.unitPrice),
        quantity: l.quantity,
        discount_amount: l.discount ? new Prisma.Decimal(l.discount) : null,
        variation: null,
        menu_item: { name: l.name ?? `Item ${i}` },
      },
    }))
  );
}

describe("buildLineItemsForBillableCharge — prorrateo del descuento manual de cuenta", () => {
  it("sin descuento manual, devuelve los montos crudos sin cambios", async () => {
    (prisma.billable_charge.findUnique as any).mockResolvedValue({
      manual_discount_applied: new Prisma.Decimal(0),
    });
    mockLines([{ unitPrice: 100, quantity: 1 }, { unitPrice: 200, quantity: 1 }]);

    const items = await buildLineItemsForBillableCharge("charge-1");

    expect(items.map((i) => i.unitPrice)).toEqual([100, 200]);
  });

  it("prorratea el descuento proporcional al peso de cada línea, sin perder ni sobrar centavos", async () => {
    (prisma.billable_charge.findUnique as any).mockResolvedValue({
      manual_discount_applied: new Prisma.Decimal(60),
    });
    // Líneas: 100 (peso 1/3) y 200 (peso 2/3). Descuento 60 => 20 y 40 respectivamente.
    mockLines([{ unitPrice: 100, quantity: 1 }, { unitPrice: 200, quantity: 1 }]);

    const items = await buildLineItemsForBillableCharge("charge-1");

    const sumOfLines = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    // 300 (crudo) - 60 (descuento) = 240, exacto, sin tolerancia.
    expect(Math.round(sumOfLines * 100) / 100).toBe(240);
    expect(items[0].unitPrice).toBeCloseTo(80, 2); // 100 - 20
    expect(items[1].unitPrice).toBeCloseTo(160, 2); // 200 - 40
  });

  it("reconcilia exacto con billable_charge.amount incluso con 3 líneas y redondeo (remanente a la última línea)", async () => {
    (prisma.billable_charge.findUnique as any).mockResolvedValue({
      manual_discount_applied: new Prisma.Decimal(10),
    });
    // 3 líneas de 33.33... cada una (total 100) — el prorrateo de 10 no divide exacto entre 3.
    mockLines([
      { unitPrice: 33.33, quantity: 1 },
      { unitPrice: 33.33, quantity: 1 },
      { unitPrice: 33.34, quantity: 1 },
    ]);

    const items = await buildLineItemsForBillableCharge("charge-1");

    const sumOfLines = items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
    expect(Math.round(sumOfLines * 100) / 100).toBe(90); // 100 - 10, exacto
  });
});
