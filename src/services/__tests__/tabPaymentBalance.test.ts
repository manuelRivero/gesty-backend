import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

import { getTableTabBalance } from "../tabPayment.service";

const BUSINESS_ID = "biz-1";
const TABLE_TAB_ID = "tab-1";

function makeTx(opts: { orderTotal: number; manualDiscountAmount: Prisma.Decimal }) {
  return {
    orders: {
      findMany: vi.fn().mockResolvedValue([
        { id: "order-1", total_amount: new Prisma.Decimal(opts.orderTotal), created_at: new Date() },
      ]),
    },
    order_item_adjustment: { findMany: vi.fn().mockResolvedValue([]) },
    tab_payment_application: { findMany: vi.fn().mockResolvedValue([]) },
    table_tab: {
      findFirst: vi.fn().mockResolvedValue({ manual_discount_amount: opts.manualDiscountAmount }),
    },
  } as any;
}

describe("getTableTabBalance — descuento manual de cuenta (VIP)", () => {
  it("resta el descuento manual del saldo agregado", async () => {
    const tx = makeTx({ orderTotal: 1000, manualDiscountAmount: new Prisma.Decimal(300) });

    const balance = await getTableTabBalance(tx, BUSINESS_ID, TABLE_TAB_ID);

    expect(balance.toNumber()).toBe(700);
  });

  it("nunca deja el saldo negativo si el descuento supera la deuda cruda", async () => {
    const tx = makeTx({ orderTotal: 200, manualDiscountAmount: new Prisma.Decimal(500) });

    const balance = await getTableTabBalance(tx, BUSINESS_ID, TABLE_TAB_ID);

    expect(balance.toNumber()).toBe(0);
  });

  it("sin descuento, comportamiento idéntico al actual", async () => {
    const tx = makeTx({ orderTotal: 1000, manualDiscountAmount: new Prisma.Decimal(0) });

    const balance = await getTableTabBalance(tx, BUSINESS_ID, TABLE_TAB_ID);

    expect(balance.toNumber()).toBe(1000);
  });
});
