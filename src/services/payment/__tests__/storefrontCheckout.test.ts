import { beforeEach, describe, expect, it, vi } from "vitest";
import { OrderPaymentStatus, Prisma } from "@prisma/client";

vi.mock("../../../lib/prisma", () => ({
  prisma: {
    payment_intent: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn()
    },
    orders: { findFirst: vi.fn(), update: vi.fn() },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        orders: { update: vi.fn() },
        payment_intent: { update: vi.fn() }
      };
      return fn(tx);
    })
  }
}));

const envState = vi.hoisted(() => ({
  STOREFRONT_PUBLIC_ORIGIN: "https://shop.test" as string | undefined
}));

vi.mock("../../../config/env", () => ({
  env: envState
}));

vi.mock("../paymentProvider.repository", () => ({
  getActiveProvider: vi.fn()
}));

vi.mock("../mercadoPago.service", () => ({
  createMpPreference: vi.fn()
}));

vi.mock("../../checkout.service", () => ({
  createOrderFromDraft: vi.fn()
}));

vi.mock("../../../socket/adminSocket", () => ({
  emitAdminOrderPaymentStatusChanged: vi.fn()
}));

vi.mock("../messageHelpers", () => ({
  sendTextMessageNoCtx: vi.fn(),
  sendImageMessageNoCtx: vi.fn()
}));

vi.mock("../../productQuery/utils", () => ({
  formatBotUserMessage: vi.fn((a: string, b: string, c: string) => `${a}${b}${c}`)
}));

vi.mock("../../pricing.service", () => ({
  computeOrderPricing: vi.fn()
}));

vi.mock("../../promotions/resolveCartPromotions", () => ({
  resolveCartPromotions: vi.fn()
}));

vi.mock("../../deliveryFee.service", () => ({
  resolveDeliveryContext: vi.fn()
}));

vi.mock("../../paymentAdjustment.service", () => ({
  resolvePaymentAdjustment: vi.fn()
}));

vi.mock("../../businessConfig.service", () => ({
  getBusinessConfig: vi.fn()
}));

vi.mock("../../ambassador/ambassadorSale.service", () => ({
  notifyAmbassadorSaleIfNeeded: vi.fn()
}));

import { prisma } from "../../../lib/prisma";
import { emitAdminOrderPaymentStatusChanged } from "../../../socket/adminSocket";
import { getActiveProvider } from "../paymentProvider.repository";
import { createMpPreference } from "../mercadoPago.service";
import {
  createStorefrontOnlineCheckout,
  handleApprovedStorefrontPayment
} from "../payment.service";

const mockedFindIntent = prisma.payment_intent.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const mockedFindOrder = prisma.orders.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedFindFirstIntent = prisma.payment_intent.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedCreateIntent = prisma.payment_intent.create as unknown as ReturnType<
  typeof vi.fn
>;
const mockedUpdateIntent = prisma.payment_intent.update as unknown as ReturnType<
  typeof vi.fn
>;
const mockedEmit = emitAdminOrderPaymentStatusChanged as unknown as ReturnType<
  typeof vi.fn
>;
const mockedGetProvider = getActiveProvider as unknown as ReturnType<typeof vi.fn>;
const mockedCreatePref = createMpPreference as unknown as ReturnType<typeof vi.fn>;

const INTENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORDER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BUSINESS_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("handleApprovedStorefrontPayment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.STOREFRONT_PUBLIC_ORIGIN = "https://shop.test";
  });

  it("marca orden paid y emite socket sin tocar draft", async () => {
    mockedFindIntent.mockResolvedValue({
      id: INTENT_ID,
      status: "pending",
      order_id: ORDER_ID,
      business_id: BUSINESS_ID,
      draft_order_id: null
    });
    mockedFindOrder.mockResolvedValue({
      id: ORDER_ID,
      payment_status: OrderPaymentStatus.unpaid
    });

    await handleApprovedStorefrontPayment(
      INTENT_ID,
      "mp-pay-1",
      { id: "mp-pay-1" } as Prisma.InputJsonValue
    );

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(mockedEmit).toHaveBeenCalledWith(BUSINESS_ID, {
      orderId: ORDER_ID,
      payment_status: OrderPaymentStatus.paid
    });
  });

  it("no-op si intent ya approved", async () => {
    mockedFindIntent.mockResolvedValue({
      id: INTENT_ID,
      status: "approved",
      order_id: ORDER_ID,
      business_id: BUSINESS_ID
    });

    await handleApprovedStorefrontPayment(
      INTENT_ID,
      "mp-pay-1",
      {} as Prisma.InputJsonValue
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("createStorefrontOnlineCheckout back_urls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envState.STOREFRONT_PUBLIC_ORIGIN = "https://shop.test";
    mockedFindFirstIntent.mockResolvedValue(null);
    mockedCreateIntent.mockResolvedValue({ id: INTENT_ID });
    mockedUpdateIntent.mockResolvedValue({});
    mockedGetProvider.mockResolvedValue({
      accessToken: "tok",
      isSandbox: true
    });
    mockedCreatePref.mockResolvedValue({
      preferenceId: "pref-1",
      initPoint: "https://mp.test/init"
    });
  });

  it("interpola slug y orderId en /orders/ con payment=*", async () => {
    await createStorefrontOnlineCheckout({
      businessId: BUSINESS_ID,
      orderId: ORDER_ID,
      slug: "domingo-sabroson",
      amount: 100,
      currency: "ARS",
      lineItems: [{ id: "i1", title: "Pizza", quantity: 1, unitPrice: 100 }]
    });

    expect(mockedCreatePref).toHaveBeenCalledWith(
      expect.objectContaining({
        externalReference: ORDER_ID,
        backUrls: {
          success: `https://shop.test/shopping/domingo-sabroson/orders/${ORDER_ID}?payment=success`,
          failure: `https://shop.test/shopping/domingo-sabroson/orders/${ORDER_ID}?payment=failure`,
          pending: `https://shop.test/shopping/domingo-sabroson/orders/${ORDER_ID}?payment=pending`
        }
      })
    );
  });

  it("produce URLs distintas por slug/orderId (no fija)", async () => {
    const otherOrder = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    await createStorefrontOnlineCheckout({
      businessId: BUSINESS_ID,
      orderId: otherOrder,
      slug: "otro-local",
      amount: 50,
      currency: "ARS",
      lineItems: [{ id: "i1", title: "Taco", quantity: 1, unitPrice: 50 }]
    });

    const backUrls = mockedCreatePref.mock.calls[0][0].backUrls;
    expect(backUrls.success).toBe(
      `https://shop.test/shopping/otro-local/orders/${otherOrder}?payment=success`
    );
    expect(backUrls.success).not.toContain("domingo-sabroson");
    expect(backUrls.success).not.toContain(ORDER_ID);
    expect(backUrls.success).not.toMatch(/\/order\//);
  });

  it("sin STOREFRONT_PUBLIC_ORIGIN omite back_urls (null, no /payment/success)", async () => {
    envState.STOREFRONT_PUBLIC_ORIGIN = undefined;

    await createStorefrontOnlineCheckout({
      businessId: BUSINESS_ID,
      orderId: ORDER_ID,
      slug: "domingo-sabroson",
      amount: 100,
      currency: "ARS",
      lineItems: [{ id: "i1", title: "Pizza", quantity: 1, unitPrice: 100 }]
    });

    expect(mockedCreatePref).toHaveBeenCalledWith(
      expect.objectContaining({ backUrls: null })
    );
  });

  it("con origin no reusa init_point viejo (recrea preference con back_urls)", async () => {
    mockedFindFirstIntent.mockResolvedValue({
      id: INTENT_ID,
      amount: { toNumber: () => 100 },
      init_point: "https://mp.test/old-without-back-urls",
      preference_id: "pref-old"
    });

    await createStorefrontOnlineCheckout({
      businessId: BUSINESS_ID,
      orderId: ORDER_ID,
      slug: "domingo-sabroson",
      amount: 100,
      currency: "ARS",
      lineItems: [{ id: "i1", title: "Pizza", quantity: 1, unitPrice: 100 }]
    });

    expect(mockedUpdateIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: INTENT_ID },
        data: expect.objectContaining({ status: "stale" })
      })
    );
    expect(mockedCreatePref).toHaveBeenCalledWith(
      expect.objectContaining({
        backUrls: expect.objectContaining({
          success: expect.stringContaining("payment=success")
        })
      })
    );
  });

  it("sin origin sí reusa init_point si amount coincide", async () => {
    envState.STOREFRONT_PUBLIC_ORIGIN = undefined;
    mockedFindFirstIntent.mockResolvedValue({
      id: INTENT_ID,
      amount: { toNumber: () => 100 },
      init_point: "https://mp.test/old",
      preference_id: "pref-old"
    });

    const result = await createStorefrontOnlineCheckout({
      businessId: BUSINESS_ID,
      orderId: ORDER_ID,
      slug: "domingo-sabroson",
      amount: 100,
      currency: "ARS",
      lineItems: [{ id: "i1", title: "Pizza", quantity: 1, unitPrice: 100 }]
    });

    expect(result?.initPoint).toBe("https://mp.test/old");
    expect(result?.isNew).toBe(false);
    expect(mockedCreatePref).not.toHaveBeenCalled();
  });

  it("encodea slug con caracteres especiales", async () => {
    await createStorefrontOnlineCheckout({
      businessId: BUSINESS_ID,
      orderId: ORDER_ID,
      slug: "café & más",
      amount: 10,
      currency: "ARS",
      lineItems: [{ id: "i1", title: "X", quantity: 1, unitPrice: 10 }]
    });

    const backUrls = mockedCreatePref.mock.calls[0][0].backUrls;
    expect(backUrls.success).toContain(
      `/shopping/${encodeURIComponent("café & más")}/orders/`
    );
  });
});
