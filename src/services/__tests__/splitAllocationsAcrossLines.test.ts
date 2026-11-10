import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { splitAllocationsAcrossLines } from "../tabPayment.service";

const d = (v: number) => new Prisma.Decimal(v);
const toNum = (allocs: Array<{ orderId: string; amount: Prisma.Decimal }>) =>
  allocs.map((a) => ({ orderId: a.orderId, amount: a.amount.toNumber() }));

/**
 * Cobro partido entre medios (DECISIÓN APROBADA, ampliación de §4.D): cada
 * línea de pago recibe su propia porción de las aplicaciones por orden, sin
 * perder ni duplicar un centavo entre medios.
 */
describe("splitAllocationsAcrossLines", () => {
  it("una sola línea con capacidad exacta: recibe toda la asignación", () => {
    const orders = [{ orderId: "A", amount: d(500) }];
    const result = splitAllocationsAcrossLines(orders, [d(500)]);
    expect(toNum(result[0])).toEqual([{ orderId: "A", amount: 500 }]);
  });

  it("dos líneas, una orden que cae justo en el límite entre ambas", () => {
    // $800 de deuda; cobro partido $500 efectivo + $300 transferencia.
    const orders = [{ orderId: "A", amount: d(800) }];
    const result = splitAllocationsAcrossLines(orders, [d(500), d(300)]);
    expect(toNum(result[0])).toEqual([{ orderId: "A", amount: 500 }]);
    expect(toNum(result[1])).toEqual([{ orderId: "A", amount: 300 }]);
  });

  it("una orden partida entre dos líneas (straddle)", () => {
    // $800 de deuda; cobro partido $300 efectivo + $500 transferencia.
    const orders = [{ orderId: "A", amount: d(800) }];
    const result = splitAllocationsAcrossLines(orders, [d(300), d(500)]);
    expect(toNum(result[0])).toEqual([{ orderId: "A", amount: 300 }]);
    expect(toNum(result[1])).toEqual([{ orderId: "A", amount: 500 }]);
  });

  it("varias órdenes repartidas entre varias líneas, conservando el total exacto", () => {
    const orders = [
      { orderId: "A", amount: d(300) },
      { orderId: "B", amount: d(400) },
      { orderId: "C", amount: d(100) },
    ];
    const result = splitAllocationsAcrossLines(orders, [d(350), d(450)]);

    const totalByLine = result.map((line) => line.reduce((s, a) => s + a.amount.toNumber(), 0));
    expect(totalByLine).toEqual([350, 450]);

    const totalByOrder = new Map<string, number>();
    for (const line of result) {
      for (const a of line) {
        totalByOrder.set(a.orderId, (totalByOrder.get(a.orderId) ?? 0) + a.amount.toNumber());
      }
    }
    expect(totalByOrder.get("A")).toBe(300);
    expect(totalByOrder.get("B")).toBe(400);
    expect(totalByOrder.get("C")).toBe(100);
  });

  it("vuelto (capacidad sobrante) cae en las últimas líneas — no genera aplicaciones de más", () => {
    // Deuda $500, cobro de dos líneas $300 + $400 (total $700, $200 de vuelto).
    const orders = [{ orderId: "A", amount: d(500) }];
    const result = splitAllocationsAcrossLines(orders, [d(300), d(400)]);
    expect(toNum(result[0])).toEqual([{ orderId: "A", amount: 300 }]);
    // La segunda línea solo recibe lo que quedaba de deuda (200), el resto es vuelto de esa línea.
    expect(toNum(result[1])).toEqual([{ orderId: "A", amount: 200 }]);
  });

  it("sin órdenes con deuda: ninguna línea recibe aplicaciones", () => {
    const result = splitAllocationsAcrossLines([], [d(500), d(300)]);
    expect(result).toEqual([[], []]);
  });
});
