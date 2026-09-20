import { FulfillmentType, OrderStatus } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    business: { findFirst: vi.fn(), findUnique: vi.fn() },
    orders: { findFirst: vi.fn() },
    storefront_order_push_subscription: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn()
    }
  }
}));

vi.mock("../../config/env", () => ({
  env: {
    VAPID_PUBLIC_KEY: "BK_test_public_key",
    VAPID_PRIVATE_KEY: "test_private_key",
    VAPID_SUBJECT: "mailto:ops@gesty.test",
    STOREFRONT_PUBLIC_ORIGIN: undefined
  },
  isWebPushConfigured: () => true
}));

vi.mock("../publicStorefront.service", () => ({
  resolveActivePublicBusiness: vi.fn()
}));

const sendNotification = vi.fn();
const setVapidDetails = vi.fn();

vi.mock("web-push", () => ({
  default: {
    setVapidDetails: (...args: unknown[]) => setVapidDetails(...args),
    sendNotification: (...args: unknown[]) => sendNotification(...args)
  }
}));

import { prisma } from "../../lib/prisma";
import { resolveActivePublicBusiness } from "../publicStorefront.service";
import { StorefrontPushError } from "../storefrontOrderPush.service";
import {
  upsertStorefrontPushSubscription,
  notifyStorefrontOrderStatusChange,
  isNotifiableStorefrontPush,
  getVapidPublicKey
} from "../storefrontOrderPush.service";

const mockedResolve = resolveActivePublicBusiness as unknown as ReturnType<
  typeof vi.fn
>;
const mockedOrderFind = prisma.orders.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedUpsert = prisma.storefront_order_push_subscription
  .upsert as unknown as ReturnType<typeof vi.fn>;
const mockedFindMany = prisma.storefront_order_push_subscription
  .findMany as unknown as ReturnType<typeof vi.fn>;
const mockedDeleteMany = prisma.storefront_order_push_subscription
  .deleteMany as unknown as ReturnType<typeof vi.fn>;
const mockedBizUnique = prisma.business.findUnique as unknown as ReturnType<
  typeof vi.fn
>;

const SUB = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc",
  expirationTime: null,
  keys: { p256dh: "p256dh-key", auth: "auth-key" }
};

describe("storefrontOrderPush.service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedResolve.mockResolvedValue({
      id: "biz-1",
      name: "Local",
      slug: "mi-local",
      description: null,
      timezone: "America/Argentina/Buenos_Aires",
      currency_code: "ARS",
      whatsapp_phone_number: null,
      street_address: null,
      address_notes: null,
      latitude: null,
      longitude: null
    });
    mockedOrderFind.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      status: OrderStatus.placed,
      fulfillment_type: FulfillmentType.TAKE_AWAY,
      business_id: "biz-1"
    });
    mockedUpsert.mockResolvedValue({});
    mockedFindMany.mockResolvedValue([]);
    mockedDeleteMany.mockResolvedValue({ count: 0 });
    mockedBizUnique.mockResolvedValue({ slug: "mi-local", name: "Domingo" });
    sendNotification.mockResolvedValue({});
  });

  it("getVapidPublicKey expone la clave pública", () => {
    expect(getVapidPublicKey()).toBe("BK_test_public_key");
  });

  it("isNotifiable: preparing, listo/en camino y delivered sí; placed no", () => {
    expect(
      isNotifiableStorefrontPush(
        FulfillmentType.TAKE_AWAY,
        OrderStatus.preparing
      )
    ).toBe(true);
    expect(
      isNotifiableStorefrontPush(
        FulfillmentType.TAKE_AWAY,
        OrderStatus.ready_for_pickup
      )
    ).toBe(true);
    expect(
      isNotifiableStorefrontPush(
        FulfillmentType.TAKE_AWAY,
        OrderStatus.delivered
      )
    ).toBe(true);
    expect(
      isNotifiableStorefrontPush(FulfillmentType.TAKE_AWAY, OrderStatus.placed)
    ).toBe(false);
    expect(
      isNotifiableStorefrontPush(FulfillmentType.DELIVERY, OrderStatus.shipped)
    ).toBe(true);
    expect(
      isNotifiableStorefrontPush(
        FulfillmentType.DELIVERY,
        OrderStatus.preparing
      )
    ).toBe(true);
    expect(
      isNotifiableStorefrontPush(
        FulfillmentType.DELIVERY,
        OrderStatus.ready_for_pickup
      )
    ).toBe(false);
  });

  it("upsert crea/actualiza subscription", async () => {
    await upsertStorefrontPushSubscription({
      slugOrId: "mi-local",
      orderId: "11111111-1111-4111-8111-111111111111",
      subscription: SUB,
      userAgent: "TestAgent/1.0"
    });

    expect(mockedUpsert).toHaveBeenCalledWith({
      where: { endpoint: SUB.endpoint },
      create: expect.objectContaining({
        order_id: "11111111-1111-4111-8111-111111111111",
        business_id: "biz-1",
        endpoint: SUB.endpoint,
        p256dh: "p256dh-key",
        auth: "auth-key",
        user_agent: "TestAgent/1.0"
      }),
      update: expect.objectContaining({
        order_id: "11111111-1111-4111-8111-111111111111",
        p256dh: "p256dh-key",
        auth: "auth-key"
      })
    });
  });

  it("upsert 404 ORDER_NOT_FOUND si el pedido no existe", async () => {
    mockedOrderFind.mockResolvedValue(null);

    await expect(
      upsertStorefrontPushSubscription({
        slugOrId: "mi-local",
        orderId: "11111111-1111-4111-8111-111111111111",
        subscription: SUB
      })
    ).rejects.toMatchObject({
      code: "ORDER_NOT_FOUND",
      httpStatus: 404
    } satisfies Partial<StorefrontPushError>);
  });

  it("upsert 409 ORDER_TERMINAL si delivered/cancelled", async () => {
    mockedOrderFind.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      status: OrderStatus.delivered,
      fulfillment_type: FulfillmentType.TAKE_AWAY,
      business_id: "biz-1"
    });

    await expect(
      upsertStorefrontPushSubscription({
        slugOrId: "mi-local",
        orderId: "11111111-1111-4111-8111-111111111111",
        subscription: SUB
      })
    ).rejects.toMatchObject({ code: "ORDER_TERMINAL", httpStatus: 409 });
  });

  it("status no notifiable (placed) no envía push", async () => {
    const result = await notifyStorefrontOrderStatusChange({
      orderId: "11111111-1111-4111-8111-111111111111",
      businessId: "biz-1",
      status: OrderStatus.placed,
      fulfillmentType: FulfillmentType.TAKE_AWAY,
      slug: "mi-local"
    });

    expect(result).toEqual({ attempted: 0, sent: 0, removed: 0 });
    expect(mockedFindMany).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("preparing envía push", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "sub-1",
        order_id: "11111111-1111-4111-8111-111111111111",
        business_id: "biz-1",
        endpoint: SUB.endpoint,
        p256dh: "p256dh-key",
        auth: "auth-key",
        user_agent: null,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);

    await notifyStorefrontOrderStatusChange({
      orderId: "11111111-1111-4111-8111-111111111111",
      businessId: "biz-1",
      status: OrderStatus.preparing,
      fulfillmentType: FulfillmentType.TAKE_AWAY,
      slug: "mi-local"
    });

    const payload = JSON.parse(
      (sendNotification.mock.calls[0] as unknown[])[1] as string
    );
    expect(payload.title).toBe("Domingo · En preparación");
    expect(payload.body).toBe("Pedido #11111111 · Están armando tu pedido.");
  });

  it("ready_for_pickup (legacy) envía push a las subscriptions", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "sub-1",
        order_id: "11111111-1111-4111-8111-111111111111",
        business_id: "biz-1",
        endpoint: SUB.endpoint,
        p256dh: "p256dh-key",
        auth: "auth-key",
        user_agent: null,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);

    const result = await notifyStorefrontOrderStatusChange({
      orderId: "11111111-1111-4111-8111-111111111111",
      businessId: "biz-1",
      status: OrderStatus.ready_for_pickup,
      fulfillmentType: FulfillmentType.TAKE_AWAY,
      slug: "mi-local"
    });

    expect(sendNotification).toHaveBeenCalledWith(
      {
        endpoint: SUB.endpoint,
        keys: { p256dh: "p256dh-key", auth: "auth-key" }
      },
      expect.stringContaining('"title":"Domingo · Listo para retirar"'),
      expect.any(Object)
    );
    const payload = JSON.parse(
      (sendNotification.mock.calls[0] as unknown[])[1] as string
    );
    expect(payload).toMatchObject({
      title: "Domingo · Listo para retirar",
      body: "Pedido #11111111 · Acercate al mostrador.",
      url: "/shopping/mi-local/order/11111111-1111-4111-8111-111111111111",
      status: "ready_for_pickup",
      orderRef: "11111111",
      businessName: "Domingo",
      tag: "gesty-order-11111111-1111-4111-8111-111111111111"
    });
    expect(result.sent).toBe(1);
    expect(result.attempted).toBe(1);
  });

  it("shipped (TAKE_AWAY / admin) envía push 'Listo para retirar'", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "sub-1",
        order_id: "11111111-1111-4111-8111-111111111111",
        business_id: "biz-1",
        endpoint: SUB.endpoint,
        p256dh: "p256dh-key",
        auth: "auth-key",
        user_agent: null,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);

    await notifyStorefrontOrderStatusChange({
      orderId: "11111111-1111-4111-8111-111111111111",
      businessId: "biz-1",
      status: OrderStatus.shipped,
      fulfillmentType: FulfillmentType.TAKE_AWAY,
      slug: "mi-local"
    });

    const payload = JSON.parse(
      (sendNotification.mock.calls[0] as unknown[])[1] as string
    );
    expect(payload).toMatchObject({
      title: "Domingo · Listo para retirar",
      body: "Pedido #11111111 · Acercate al mostrador.",
      status: "shipped"
    });
  });

  it("shipped (DELIVERY) envía push", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "sub-1",
        order_id: "11111111-1111-4111-8111-111111111111",
        business_id: "biz-1",
        endpoint: SUB.endpoint,
        p256dh: "p256dh-key",
        auth: "auth-key",
        user_agent: null,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);

    await notifyStorefrontOrderStatusChange({
      orderId: "11111111-1111-4111-8111-111111111111",
      businessId: "biz-1",
      status: OrderStatus.shipped,
      fulfillmentType: FulfillmentType.DELIVERY,
      slug: "mi-local"
    });

    const payload = JSON.parse(
      (sendNotification.mock.calls[0] as unknown[])[1] as string
    );
    expect(payload.title).toBe("Domingo · En camino");
    expect(payload.body).toBe(
      "Pedido #11111111 · El repartidor ya salió hacia tu dirección."
    );
    expect(payload.status).toBe("shipped");
  });

  it("410 Gone borra la subscription", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "sub-gone",
        order_id: "11111111-1111-4111-8111-111111111111",
        business_id: "biz-1",
        endpoint: SUB.endpoint,
        p256dh: "p256dh-key",
        auth: "auth-key",
        user_agent: null,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);
    sendNotification.mockRejectedValue({ statusCode: 410 });

    const result = await notifyStorefrontOrderStatusChange({
      orderId: "11111111-1111-4111-8111-111111111111",
      businessId: "biz-1",
      status: OrderStatus.ready_for_pickup,
      fulfillmentType: FulfillmentType.TAKE_AWAY,
      slug: "mi-local"
    });

    expect(result.removed).toBe(1);
    expect(mockedDeleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["sub-gone"] } }
    });
  });

  it("cancelled limpia subscriptions tras notificar", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "sub-1",
        order_id: "11111111-1111-4111-8111-111111111111",
        business_id: "biz-1",
        endpoint: SUB.endpoint,
        p256dh: "p256dh-key",
        auth: "auth-key",
        user_agent: null,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);

    await notifyStorefrontOrderStatusChange({
      orderId: "11111111-1111-4111-8111-111111111111",
      businessId: "biz-1",
      status: OrderStatus.cancelled,
      fulfillmentType: FulfillmentType.TAKE_AWAY,
      slug: "mi-local"
    });

    expect(sendNotification).toHaveBeenCalled();
    expect(mockedDeleteMany).toHaveBeenCalledWith({
      where: { order_id: "11111111-1111-4111-8111-111111111111" }
    });
  });

  it("delivered envía push y limpia subscriptions", async () => {
    mockedFindMany.mockResolvedValue([
      {
        id: "sub-1",
        order_id: "11111111-1111-4111-8111-111111111111",
        business_id: "biz-1",
        endpoint: SUB.endpoint,
        p256dh: "p256dh-key",
        auth: "auth-key",
        user_agent: null,
        created_at: new Date(),
        updated_at: new Date()
      }
    ]);

    await notifyStorefrontOrderStatusChange({
      orderId: "11111111-1111-4111-8111-111111111111",
      businessId: "biz-1",
      status: OrderStatus.delivered,
      fulfillmentType: FulfillmentType.TAKE_AWAY,
      slug: "mi-local"
    });

    const payload = JSON.parse(
      (sendNotification.mock.calls[0] as unknown[])[1] as string
    );
    expect(payload.title).toBe("Domingo · Entregado");
    expect(payload.body).toBe("Pedido #11111111 · ¡Buen provecho!");
    expect(mockedDeleteMany).toHaveBeenCalledWith({
      where: { order_id: "11111111-1111-4111-8111-111111111111" }
    });
  });
});
