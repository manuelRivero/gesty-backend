import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    menu_item: { findMany: vi.fn() },
    orders: { create: vi.fn(), findFirst: vi.fn() },
    customer_address: { updateMany: vi.fn(), create: vi.fn() },
    payment_intent: { findFirst: vi.fn() },
    $executeRaw: vi.fn()
  }
}));

vi.mock("../../repositories/customer.repository", () => ({
  findOrCreateCustomer: vi.fn()
}));

vi.mock("../../repositories/coverageZone.repository", () => ({
  findCoverageZoneForPoint: vi.fn()
}));

vi.mock("../../socket/adminSocket", () => ({
  emitAdminOrderCreated: vi.fn()
}));

vi.mock("../businessConfig.service", () => ({
  getBusinessConfig: vi.fn(),
  hasDeliveryCapability: (config: {
    delivery_enabled?: boolean;
    external_delivery_enabled?: boolean;
  }) =>
    Boolean(config.delivery_enabled || config.external_delivery_enabled)
}));

vi.mock("../businessHours.service", () => ({
  getBusinessOpenInfo: vi.fn()
}));

vi.mock("../publicStorefront.service", () => ({
  resolveActivePublicBusiness: vi.fn()
}));

vi.mock("../paymentMethods.service", () => ({
  isPaymentMethodOffered: vi.fn()
}));

vi.mock("../paymentAdjustment.service", () => ({
  resolvePaymentAdjustment: vi.fn()
}));

vi.mock("../payment/payment.service", () => ({
  createStorefrontOnlineCheckout: vi.fn()
}));

vi.mock("../../helpers/menuItemPrice.helper", () => ({
  activePriceSelect: vi.fn().mockReturnValue({}),
  resolveEffectivePrice: vi.fn()
}));

import { prisma } from "../../lib/prisma";
import { findOrCreateCustomer } from "../../repositories/customer.repository";
import { findCoverageZoneForPoint } from "../../repositories/coverageZone.repository";
import { emitAdminOrderCreated } from "../../socket/adminSocket";
import { resolveEffectivePrice } from "../../helpers/menuItemPrice.helper";
import { getBusinessConfig } from "../businessConfig.service";
import { getBusinessOpenInfo } from "../businessHours.service";
import { resolveActivePublicBusiness } from "../publicStorefront.service";
import { isPaymentMethodOffered } from "../paymentMethods.service";
import { resolvePaymentAdjustment } from "../paymentAdjustment.service";
import { createStorefrontOnlineCheckout } from "../payment/payment.service";
import {
  COUNTER_PAYMENT_METHOD,
  createPublicCounterOrder,
  createPublicOrderCheckout,
  getPublicCounterOrder,
  PublicOrderError,
  quotePublicDelivery
} from "../publicOrders.service";

const mockedResolveBusiness = resolveActivePublicBusiness as unknown as ReturnType<
  typeof vi.fn
>;
const mockedConfig = getBusinessConfig as unknown as ReturnType<typeof vi.fn>;
const mockedOpen = getBusinessOpenInfo as unknown as ReturnType<typeof vi.fn>;
const mockedItems = prisma.menu_item.findMany as unknown as ReturnType<
  typeof vi.fn
>;
const mockedCreate = prisma.orders.create as unknown as ReturnType<typeof vi.fn>;
const mockedFindOrder = prisma.orders.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedCustomer = findOrCreateCustomer as unknown as ReturnType<
  typeof vi.fn
>;
const mockedEmit = emitAdminOrderCreated as unknown as ReturnType<typeof vi.fn>;
const mockedPrice = resolveEffectivePrice as unknown as ReturnType<typeof vi.fn>;
const mockedZone = findCoverageZoneForPoint as unknown as ReturnType<typeof vi.fn>;
const mockedOffered = isPaymentMethodOffered as unknown as ReturnType<typeof vi.fn>;
const mockedPayAdj = resolvePaymentAdjustment as unknown as ReturnType<
  typeof vi.fn
>;
const mockedCheckout = createStorefrontOnlineCheckout as unknown as ReturnType<
  typeof vi.fn
>;
const mockedIntentFind = prisma.payment_intent
  .findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedAddrUpdate = prisma.customer_address
  .updateMany as unknown as ReturnType<typeof vi.fn>;
const mockedAddrCreate = prisma.customer_address
  .create as unknown as ReturnType<typeof vi.fn>;
const mockedExecuteRaw = prisma.$executeRaw as unknown as ReturnType<typeof vi.fn>;

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "44444444-4444-4444-8444-444444444444";
const ZONE_ID = "55555555-5555-4555-8555-555555555555";
const ADDRESS_ID = "66666666-6666-4666-8666-666666666666";

function setupHappyPath(opts?: { variations?: string[] }) {
  mockedResolveBusiness.mockResolvedValue({
    id: BUSINESS_ID,
    name: "Sabrosón",
    description: null,
    slug: "sabroson",
    timezone: "America/Argentina/Buenos_Aires",
    currency_code: "ARS",
    whatsapp_phone_number: null,
    street_address: null,
    address_notes: null,
    latitude: null,
    longitude: null
  });
  mockedConfig.mockResolvedValue({
    orders_enabled: true,
    takeaway_enabled: true,
    delivery_enabled: true,
    external_delivery_enabled: false,
    orders_when_closed: false
  });
  mockedOpen.mockResolvedValue({ isOpen: true, nextOpenText: null });
  mockedOffered.mockResolvedValue(true);
  mockedPayAdj.mockResolvedValue({
    adjustmentAmount: 0,
    label: null,
    hasAdjustment: false
  });
  mockedIntentFind.mockResolvedValue(null);
  mockedItems.mockResolvedValue([
    {
      id: ITEM_ID,
      name: "Muzza",
      is_available: true,
      serves_people: 2,
      variations: opts?.variations ?? [],
      discount_type: null,
      discount_value: null,
      menu_item_price: [
        {
          id: "p1",
          currency_code: "ARS",
          amount: new Prisma.Decimal("4500.00")
        }
      ]
    }
  ]);
  mockedPrice.mockReturnValue({
    listPrice: new Prisma.Decimal("4500.00"),
    discountAmount: new Prisma.Decimal(0),
    finalPrice: new Prisma.Decimal("4500.00"),
    hasDiscount: false
  });
  mockedCustomer.mockResolvedValue({
    id: CUSTOMER_ID,
    name: "Juan",
    phone_number: "5491112345678"
  });
  mockedCreate.mockResolvedValue({
    id: ORDER_ID,
    status: "placed",
    payment_status: "unpaid",
    payment_method: "cash",
    fulfillment_type: "TAKE_AWAY",
    currency_code: "ARS",
    total_amount: new Prisma.Decimal("4500.00"),
    delivery_fee: null,
    created_at: new Date("2026-09-20T15:00:00.000Z")
  });
  mockedAddrUpdate.mockResolvedValue({ count: 0 });
  mockedAddrCreate.mockResolvedValue({ id: ADDRESS_ID });
  mockedExecuteRaw.mockResolvedValue(1);
}

describe("quotePublicDelivery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
  });

  it("200 inCoverage con fee/mínimo/ETA", async () => {
    mockedZone.mockResolvedValue({
      id: ZONE_ID,
      name: "Centro",
      delivery_fee: "800.00",
      min_order_amount: "5000.00",
      estimated_delivery_minutes: 40,
      priority: 1
    });

    const quote = await quotePublicDelivery({
      slugOrId: "sabroson",
      latitude: -32.95,
      longitude: -60.66,
      itemsSubtotal: 4500
    });

    expect(quote).toEqual({
      inCoverage: true,
      deliveryFee: "800.00",
      minOrderAmount: "5000.00",
      minOrderMet: false,
      estimatedMinutes: 40,
      zoneId: ZONE_ID,
      zoneName: "Centro"
    });
  });

  it("inCoverage false sin zona (no lanza)", async () => {
    mockedZone.mockResolvedValue(null);

    const quote = await quotePublicDelivery({
      slugOrId: "sabroson",
      latitude: -32.95,
      longitude: -60.66
    });

    expect(quote.inCoverage).toBe(false);
    expect(quote.deliveryFee).toBeNull();
  });

  it("403 si no hay delivery propio ni externo", async () => {
    mockedConfig.mockResolvedValue({
      orders_enabled: true,
      takeaway_enabled: true,
      delivery_enabled: false,
      external_delivery_enabled: false,
      orders_when_closed: false
    });

    await expect(
      quotePublicDelivery({
        slugOrId: "sabroson",
        latitude: -32.95,
        longitude: -60.66
      })
    ).rejects.toMatchObject({ code: "DELIVERY_DISABLED", httpStatus: 403 });
  });

  it("permite quote con solo external_delivery_enabled", async () => {
    mockedConfig.mockResolvedValue({
      orders_enabled: true,
      takeaway_enabled: true,
      delivery_enabled: false,
      external_delivery_enabled: true,
      orders_when_closed: false
    });
    mockedZone.mockResolvedValue({
      id: ZONE_ID,
      name: "Centro",
      delivery_fee: new Prisma.Decimal(500),
      min_order_amount: new Prisma.Decimal(0),
      estimated_delivery_minutes: 40
    });

    const quote = await quotePublicDelivery({
      slugOrId: "sabroson",
      latitude: -32.95,
      longitude: -60.66
    });

    expect(quote).toMatchObject({
      inCoverage: true,
      deliveryFee: "500.00",
      zoneId: ZONE_ID
    });
  });

  it("400 INVALID_COORDINATES", async () => {
    await expect(
      quotePublicDelivery({
        slugOrId: "sabroson",
        latitude: 999,
        longitude: -60.66
      })
    ).rejects.toMatchObject({ code: "INVALID_COORDINATES", httpStatus: 400 });
  });
});

describe("createPublicCounterOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("crea orden cash unpaid TAKE_AWAY sin conversation", async () => {
    setupHappyPath();

    const result = await createPublicCounterOrder({
      slugOrId: "sabroson",
      customer: { name: "Juan", phone: "+54 9 11 1234-5678" },
      items: [{ menuItemId: ITEM_ID, quantity: 1 }]
    });

    expect(result).toMatchObject({
      orderId: ORDER_ID,
      status: "placed",
      paymentStatus: "unpaid",
      paymentMethod: COUNTER_PAYMENT_METHOD,
      fulfillmentType: "TAKE_AWAY",
      total: "4500.00",
      currencyCode: "ARS",
      deliveryFee: null,
      address: null,
      checkoutUrl: null
    });

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          business_id: BUSINESS_ID,
          customer_id: CUSTOMER_ID,
          conversation_id: null,
          status: "placed",
          payment_status: "unpaid",
          payment_method: "cash",
          fulfillment_type: "TAKE_AWAY"
        })
      })
    );
    expect(mockedEmit).toHaveBeenCalledWith(
      BUSINESS_ID,
      expect.objectContaining({ orderId: ORDER_ID })
    );
    expect(mockedZone).not.toHaveBeenCalled();
  });

  it("crea orden online con checkoutUrl", async () => {
    setupHappyPath();
    mockedCheckout.mockResolvedValue({
      initPoint: "https://mp.test/checkout",
      preferenceId: "pref-1",
      paymentIntentId: "pi-1",
      isNew: true
    });
    mockedCreate.mockResolvedValue({
      id: ORDER_ID,
      status: "placed",
      payment_status: "unpaid",
      payment_method: "online",
      fulfillment_type: "TAKE_AWAY",
      currency_code: "ARS",
      total_amount: new Prisma.Decimal("4500.00"),
      delivery_fee: null,
      created_at: new Date("2026-09-20T15:00:00.000Z")
    });

    const result = await createPublicCounterOrder({
      slugOrId: "sabroson",
      customer: { phone: "5491112345678" },
      items: [{ menuItemId: ITEM_ID, quantity: 1 }],
      paymentMethod: "online"
    });

    expect(result).toMatchObject({
      paymentMethod: "online",
      checkoutUrl: "https://mp.test/checkout",
      total: "4500.00"
    });
    expect(mockedCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BUSINESS_ID,
        orderId: ORDER_ID,
        slug: "sabroson",
        amount: 4500
      })
    );
  });

  it("403 ONLINE_PAYMENT_UNAVAILABLE si online no ofrecido", async () => {
    setupHappyPath();
    mockedOffered.mockResolvedValue(false);

    await expect(
      createPublicCounterOrder({
        slugOrId: "sabroson",
        customer: { phone: "5491112345678" },
        items: [{ menuItemId: ITEM_ID, quantity: 1 }],
        paymentMethod: "online"
      })
    ).rejects.toMatchObject({
      code: "ONLINE_PAYMENT_UNAVAILABLE",
      httpStatus: 403
    });
  });

  it("crea orden DELIVERY con fee, snapshot y address", async () => {
    setupHappyPath();
    mockedZone.mockResolvedValue({
      id: ZONE_ID,
      name: "Centro",
      delivery_fee: "800.00",
      min_order_amount: "0",
      estimated_delivery_minutes: 40,
      priority: 1
    });
    mockedCreate.mockResolvedValue({
      id: ORDER_ID,
      status: "placed",
      payment_status: "unpaid",
      payment_method: "cash",
      fulfillment_type: "DELIVERY",
      currency_code: "ARS",
      total_amount: new Prisma.Decimal("5300.00"),
      delivery_fee: new Prisma.Decimal("800.00"),
      created_at: new Date("2026-09-20T15:00:00.000Z")
    });

    const result = await createPublicCounterOrder({
      slugOrId: "sabroson",
      customer: { name: "Juan", phone: "5491112345678" },
      items: [{ menuItemId: ITEM_ID, quantity: 1 }],
      fulfillmentType: "DELIVERY",
      address: {
        latitude: -32.95,
        longitude: -60.66,
        streetAddress: "Mitre 1200",
        apartment: "3B",
        city: "Rosario",
        instructions: "Timbre roto"
      }
    });

    expect(result).toMatchObject({
      fulfillmentType: "DELIVERY",
      total: "5300.00",
      deliveryFee: "800.00",
      address: {
        streetAddress: "Mitre 1200",
        apartment: "3B",
        city: "Rosario",
        instructions: "Timbre roto"
      }
    });

    expect(mockedAddrCreate).toHaveBeenCalled();
    expect(mockedExecuteRaw).toHaveBeenCalled();
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          fulfillment_type: "DELIVERY",
          customer_address_id: ADDRESS_ID,
          delivery_fee: 800,
          delivery_address_snapshot: expect.objectContaining({
            street_address: "Mitre 1200",
            apartment: "3B",
            latitude: -32.95,
            longitude: -60.66
          })
        })
      })
    );
  });

  it("OUT_OF_COVERAGE si el pin no cae en zona", async () => {
    setupHappyPath();
    mockedZone.mockResolvedValue(null);

    await expect(
      createPublicCounterOrder({
        slugOrId: "sabroson",
        customer: { phone: "5491112345678" },
        items: [{ menuItemId: ITEM_ID, quantity: 1 }],
        fulfillmentType: "DELIVERY",
        address: {
          latitude: -32.95,
          longitude: -60.66,
          streetAddress: "Mitre 1200"
        }
      })
    ).rejects.toMatchObject({ code: "OUT_OF_COVERAGE", httpStatus: 400 });
  });

  it("MIN_ORDER_NOT_MET si subtotal < mínimo de zona", async () => {
    setupHappyPath();
    mockedZone.mockResolvedValue({
      id: ZONE_ID,
      name: "Centro",
      delivery_fee: "800.00",
      min_order_amount: "10000.00",
      estimated_delivery_minutes: 40,
      priority: 1
    });

    await expect(
      createPublicCounterOrder({
        slugOrId: "sabroson",
        customer: { phone: "5491112345678" },
        items: [{ menuItemId: ITEM_ID, quantity: 1 }],
        fulfillmentType: "DELIVERY",
        address: {
          latitude: -32.95,
          longitude: -60.66,
          streetAddress: "Mitre 1200"
        }
      })
    ).rejects.toMatchObject({ code: "MIN_ORDER_NOT_MET", httpStatus: 400 });
  });

  it("403 DELIVERY_DISABLED sin delivery propio ni externo", async () => {
    setupHappyPath();
    mockedConfig.mockResolvedValue({
      orders_enabled: true,
      takeaway_enabled: true,
      delivery_enabled: false,
      external_delivery_enabled: false,
      orders_when_closed: false
    });

    await expect(
      createPublicCounterOrder({
        slugOrId: "sabroson",
        customer: { phone: "5491112345678" },
        items: [{ menuItemId: ITEM_ID, quantity: 1 }],
        fulfillmentType: "DELIVERY",
        address: {
          latitude: -32.95,
          longitude: -60.66,
          streetAddress: "Mitre 1200"
        }
      })
    ).rejects.toMatchObject({ code: "DELIVERY_DISABLED", httpStatus: 403 });
  });

  it("permite DELIVERY con solo external_delivery_enabled", async () => {
    setupHappyPath();
    mockedConfig.mockResolvedValue({
      orders_enabled: true,
      takeaway_enabled: true,
      delivery_enabled: false,
      external_delivery_enabled: true,
      orders_when_closed: false
    });
    mockedZone.mockResolvedValue({
      id: ZONE_ID,
      name: "Centro",
      delivery_fee: "500.00",
      min_order_amount: "0",
      estimated_delivery_minutes: 40,
      priority: 1
    });
    mockedCreate.mockResolvedValue({
      id: ORDER_ID,
      status: "placed",
      payment_status: "unpaid",
      payment_method: "cash",
      fulfillment_type: "DELIVERY",
      currency_code: "ARS",
      total_amount: new Prisma.Decimal("5000.00"),
      delivery_fee: new Prisma.Decimal("500.00"),
      created_at: new Date("2026-09-20T15:00:00.000Z")
    });

    const result = await createPublicCounterOrder({
      slugOrId: "sabroson",
      customer: { phone: "5491112345678" },
      items: [{ menuItemId: ITEM_ID, quantity: 1 }],
      fulfillmentType: "DELIVERY",
      address: {
        latitude: -32.95,
        longitude: -60.66,
        streetAddress: "Mitre 1200"
      }
    });

    expect(result.fulfillmentType).toBe("DELIVERY");
    expect(result.deliveryFee).toBe("500.00");
  });

  it("exige variación cuando el ítem la tiene", async () => {
    setupHappyPath({ variations: ["Roquefort", "Napolitana"] });

    await expect(
      createPublicCounterOrder({
        slugOrId: "sabroson",
        customer: { phone: "5491112345678" },
        items: [{ menuItemId: ITEM_ID, quantity: 1 }]
      })
    ).rejects.toMatchObject({
      code: "VARIATION_REQUIRED",
      httpStatus: 400
    });
  });

  it("resuelve variación y congela precio de servidor", async () => {
    setupHappyPath({ variations: ["Roquefort", "Napolitana"] });

    await createPublicCounterOrder({
      slugOrId: "sabroson",
      customer: { phone: "5491112345678" },
      items: [{ menuItemId: ITEM_ID, quantity: 2, variation: "roquefor" }]
    });

    const createData = mockedCreate.mock.calls[0][0].data;
    expect(createData.order_item.create[0].variation).toBe("Roquefort");
    expect(createData.order_item.create[0].quantity).toBe(2);
  });

  it("403 si orders_enabled=false", async () => {
    setupHappyPath();
    mockedConfig.mockResolvedValue({
      orders_enabled: false,
      takeaway_enabled: true,
      delivery_enabled: true,
      orders_when_closed: false
    });

    await expect(
      createPublicCounterOrder({
        slugOrId: "sabroson",
        customer: { phone: "5491112345678" },
        items: [{ menuItemId: ITEM_ID, quantity: 1 }]
      })
    ).rejects.toMatchObject({ code: "ORDERS_DISABLED", httpStatus: 403 });
  });

  it("403 si cerrado y orders_when_closed=false", async () => {
    setupHappyPath();
    mockedOpen.mockResolvedValue({
      isOpen: false,
      nextOpenText: "Lunes a las 11:00 hs"
    });

    await expect(
      createPublicCounterOrder({
        slugOrId: "sabroson",
        customer: { phone: "5491112345678" },
        items: [{ menuItemId: ITEM_ID, quantity: 1 }]
      })
    ).rejects.toMatchObject({ code: "CLOSED", httpStatus: 403 });
  });

  it("404 si el local no existe", async () => {
    mockedResolveBusiness.mockResolvedValue(null);

    await expect(
      createPublicCounterOrder({
        slugOrId: "ghost",
        customer: { phone: "5491112345678" },
        items: [{ menuItemId: ITEM_ID, quantity: 1 }]
      })
    ).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE", httpStatus: 404 });
  });
});

describe("getPublicCounterOrder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedResolveBusiness.mockResolvedValue({
      id: BUSINESS_ID,
      name: "Sabrosón",
      description: null,
      slug: "sabroson",
      timezone: "America/Argentina/Buenos_Aires",
      currency_code: "ARS",
      whatsapp_phone_number: null,
      street_address: null,
      address_notes: null,
      latitude: null,
      longitude: null
    });
  });

  it("devuelve la misma forma que el 201 con status actualizado", async () => {
    mockedFindOrder.mockResolvedValue({
      id: ORDER_ID,
      status: "ready_for_pickup",
      payment_status: "unpaid",
      payment_method: "cash",
      fulfillment_type: "TAKE_AWAY",
      currency_code: "ARS",
      total_amount: new Prisma.Decimal("9000.00"),
      delivery_fee: null,
      delivery_address_snapshot: {},
      created_at: new Date("2026-09-20T15:00:00.000Z"),
      customer: {
        id: CUSTOMER_ID,
        name: "Juan",
        phone_number: "5491112345678"
      },
      order_item: [
        {
          menu_item_id: ITEM_ID,
          quantity: 2,
          unit_price: new Prisma.Decimal("4500.00"),
          notes: null,
          variation: "Roquefort",
          menu_item: { name: "Muzza" }
        }
      ]
    });

    const view = await getPublicCounterOrder({
      slugOrId: "sabroson",
      orderId: ORDER_ID
    });

    expect(view).toMatchObject({
      orderId: ORDER_ID,
      status: "ready_for_pickup",
      paymentStatus: "unpaid",
      paymentMethod: "cash",
      fulfillmentType: "TAKE_AWAY",
      currencyCode: "ARS",
      total: "9000.00",
      deliveryFee: null,
      address: null,
      checkoutUrl: null,
      customer: {
        id: CUSTOMER_ID,
        name: "Juan",
        phone: "5491112345678"
      },
      items: [
        {
          menuItemId: ITEM_ID,
          name: "Muzza",
          quantity: 2,
          variation: "Roquefort",
          unitPrice: "4500.00",
          lineTotal: "9000.00"
        }
      ]
    });
  });

  it("expone fee + address en pedidos DELIVERY", async () => {
    mockedFindOrder.mockResolvedValue({
      id: ORDER_ID,
      status: "shipped",
      payment_status: "unpaid",
      payment_method: "cash",
      fulfillment_type: "DELIVERY",
      currency_code: "ARS",
      total_amount: new Prisma.Decimal("5300.00"),
      delivery_fee: new Prisma.Decimal("800.00"),
      delivery_address_snapshot: {
        street_address: "Mitre 1200",
        apartment: "3B",
        neighborhood: null,
        city: "Rosario",
        delivery_instructions: "Timbre roto"
      },
      created_at: new Date("2026-09-20T15:00:00.000Z"),
      customer: {
        id: CUSTOMER_ID,
        name: "Juan",
        phone_number: "5491112345678"
      },
      order_item: [
        {
          menu_item_id: ITEM_ID,
          quantity: 1,
          unit_price: new Prisma.Decimal("4500.00"),
          notes: null,
          variation: null,
          menu_item: { name: "Muzza" }
        }
      ]
    });

    const view = await getPublicCounterOrder({
      slugOrId: "sabroson",
      orderId: ORDER_ID
    });

    expect(view).toMatchObject({
      fulfillmentType: "DELIVERY",
      deliveryFee: "800.00",
      address: {
        streetAddress: "Mitre 1200",
        apartment: "3B",
        city: "Rosario",
        instructions: "Timbre roto"
      }
    });
  });

  it("404 si el pedido no es del business", async () => {
    mockedFindOrder.mockResolvedValue(null);

    await expect(
      getPublicCounterOrder({ slugOrId: "sabroson", orderId: ORDER_ID })
    ).rejects.toMatchObject({ code: "ORDER_NOT_FOUND", httpStatus: 404 });
  });

  it("404 si el local no existe", async () => {
    mockedResolveBusiness.mockResolvedValue(null);

    await expect(
      getPublicCounterOrder({ slugOrId: "ghost", orderId: ORDER_ID })
    ).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE", httpStatus: 404 });
  });
});

describe("createPublicOrderCheckout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupHappyPath();
  });

  it("reusa/regen link para orden unpaid online", async () => {
    mockedFindOrder.mockResolvedValue({
      id: ORDER_ID,
      payment_status: "unpaid",
      payment_method: "online",
      total_amount: new Prisma.Decimal("4500.00"),
      delivery_fee: null,
      payment_adjustment: null,
      currency_code: "ARS",
      order_item: [
        {
          menu_item_id: ITEM_ID,
          quantity: 1,
          unit_price: new Prisma.Decimal("4500.00"),
          menu_item: { name: "Muzza" }
        }
      ]
    });
    mockedCheckout.mockResolvedValue({
      initPoint: "https://mp.test/again",
      preferenceId: "pref-2",
      paymentIntentId: "pi-2",
      isNew: false
    });

    const result = await createPublicOrderCheckout({
      slugOrId: "sabroson",
      orderId: ORDER_ID
    });

    expect(result).toEqual({
      checkoutUrl: "https://mp.test/again",
      orderId: ORDER_ID
    });
  });

  it("409 si ya está pagado", async () => {
    mockedFindOrder.mockResolvedValue({
      id: ORDER_ID,
      payment_status: "paid",
      payment_method: "online",
      total_amount: new Prisma.Decimal("4500.00"),
      delivery_fee: null,
      payment_adjustment: null,
      currency_code: "ARS",
      order_item: []
    });

    await expect(
      createPublicOrderCheckout({ slugOrId: "sabroson", orderId: ORDER_ID })
    ).rejects.toMatchObject({ code: "ALREADY_PAID", httpStatus: 409 });
  });
});
