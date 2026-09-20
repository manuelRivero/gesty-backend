import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    menu_item: { findMany: vi.fn() },
    orders: { create: vi.fn(), findFirst: vi.fn() }
  }
}));

vi.mock("../../repositories/customer.repository", () => ({
  findOrCreateCustomer: vi.fn()
}));

vi.mock("../../socket/adminSocket", () => ({
  emitAdminOrderCreated: vi.fn()
}));

vi.mock("../businessConfig.service", () => ({
  getBusinessConfig: vi.fn()
}));

vi.mock("../businessHours.service", () => ({
  getBusinessOpenInfo: vi.fn()
}));

vi.mock("../publicStorefront.service", () => ({
  resolveActivePublicBusiness: vi.fn()
}));

vi.mock("../../helpers/menuItemPrice.helper", () => ({
  activePriceSelect: vi.fn().mockReturnValue({}),
  resolveEffectivePrice: vi.fn()
}));

import { prisma } from "../../lib/prisma";
import { findOrCreateCustomer } from "../../repositories/customer.repository";
import { emitAdminOrderCreated } from "../../socket/adminSocket";
import { resolveEffectivePrice } from "../../helpers/menuItemPrice.helper";
import { getBusinessConfig } from "../businessConfig.service";
import { getBusinessOpenInfo } from "../businessHours.service";
import { resolveActivePublicBusiness } from "../publicStorefront.service";
import {
  COUNTER_PAYMENT_METHOD,
  createPublicCounterOrder,
  getPublicCounterOrder,
  PublicOrderError
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

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const CUSTOMER_ID = "33333333-3333-4333-8333-333333333333";
const ORDER_ID = "44444444-4444-4444-8444-444444444444";

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
    orders_when_closed: false
  });
  mockedOpen.mockResolvedValue({ isOpen: true, nextOpenText: null });
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
    created_at: new Date("2026-09-20T15:00:00.000Z")
  });
}

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
      currencyCode: "ARS"
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
      orders_when_closed: false
    });

    await expect(
      createPublicCounterOrder({
        slugOrId: "sabroson",
        customer: { phone: "5491112345678" },
        items: [{ menuItemId: ITEM_ID, quantity: 1 }]
      })
    ).rejects.toBeInstanceOf(PublicOrderError);

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
    expect(mockedFindOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ORDER_ID, business_id: BUSINESS_ID }
      })
    );
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
