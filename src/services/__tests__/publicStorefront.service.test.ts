import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    business: { findFirst: vi.fn() },
    business_hours: { findMany: vi.fn() },
    business_config: { findUnique: vi.fn() },
    payment_method_config: { findMany: vi.fn() },
    menu_category: { findMany: vi.fn() },
    menu_item: { findMany: vi.fn() }
  }
}));

vi.mock("../businessHours.service", () => ({
  getBusinessOpenInfo: vi.fn()
}));

vi.mock("../../helpers/menuItemPrice.helper", () => ({
  getBusinessCurrencyCode: vi.fn().mockResolvedValue("ARS"),
  activePriceSelect: vi.fn().mockReturnValue({
    where: {},
    orderBy: { valid_from: "desc" },
    take: 1,
    select: { id: true, currency_code: true, amount: true }
  }),
  toMenuItemPriceDto: (price: {
    id: string;
    currency_code: string;
    amount: { toFixed(n: number): string };
  }) => ({
    id: price.id,
    currencyCode: price.currency_code,
    amount: price.amount.toFixed(2)
  }),
  resolveEffectivePrice: () => ({
    hasDiscount: false,
    discountAmount: { toFixed: () => "0.00" },
    finalPrice: { toFixed: () => "0.00" },
    listPrice: { toFixed: () => "0.00" }
  })
}));

import { prisma } from "../../lib/prisma";
import { getBusinessOpenInfo } from "../businessHours.service";
import {
  getPublicStorefrontFulfillment,
  getPublicStorefrontHours,
  getPublicStorefrontPaymentMethods,
  getPublicStorefrontProfile,
  listPublicMenuCategories,
  listPublicMenuItems,
  looksLikeUuid,
  resolveActivePublicBusiness
} from "../publicStorefront.service";

const mockedBusinessFind = prisma.business.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedHoursFind = prisma.business_hours.findMany as unknown as ReturnType<
  typeof vi.fn
>;
const mockedConfigFind = prisma.business_config
  .findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedPaymentFind = prisma.payment_method_config
  .findMany as unknown as ReturnType<typeof vi.fn>;
const mockedCategoryFind = prisma.menu_category
  .findMany as unknown as ReturnType<typeof vi.fn>;
const mockedItemFind = prisma.menu_item.findMany as unknown as ReturnType<
  typeof vi.fn
>;
const mockedOpenInfo = getBusinessOpenInfo as unknown as ReturnType<
  typeof vi.fn
>;

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";

function baseBusiness() {
  return {
    id: BUSINESS_ID,
    name: "Sabrosón",
    description: "Pizza y empanadas",
    slug: "sabroson",
    timezone: "America/Argentina/Buenos_Aires",
    currency_code: "ARS",
    whatsapp_phone_number: "549111",
    street_address: "Calle 1",
    address_notes: null,
    latitude: -34.6,
    longitude: -58.4
  };
}

describe("looksLikeUuid", () => {
  it("detecta UUID v4", () => {
    expect(looksLikeUuid(BUSINESS_ID)).toBe(true);
    expect(looksLikeUuid("sabroson")).toBe(false);
  });
});

describe("resolveActivePublicBusiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("busca por slug cuando no es UUID", async () => {
    mockedBusinessFind.mockResolvedValue(baseBusiness());
    const row = await resolveActivePublicBusiness("sabroson");
    expect(row?.slug).toBe("sabroson");
    expect(mockedBusinessFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { slug: "sabroson", is_active: true }
      })
    );
  });

  it("busca por id cuando es UUID", async () => {
    mockedBusinessFind.mockResolvedValue(baseBusiness());
    await resolveActivePublicBusiness(BUSINESS_ID);
    expect(mockedBusinessFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BUSINESS_ID, is_active: true }
      })
    );
  });

  it("devuelve null si no hay local activo", async () => {
    mockedBusinessFind.mockResolvedValue(null);
    expect(await resolveActivePublicBusiness("ghost")).toBeNull();
  });
});

describe("getPublicStorefrontProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedBusinessFind.mockResolvedValue(baseBusiness());
    mockedHoursFind.mockResolvedValue([
      {
        id: "h1",
        day_of_week: 1,
        opens_at: "11:00",
        closes_at: "23:00",
        is_closed: false
      }
    ]);
    mockedOpenInfo.mockResolvedValue({
      isOpen: true,
      nextOpenText: null
    });
  });

  it("arma perfil con isOpen e imageUrl null", async () => {
    const profile = await getPublicStorefrontProfile("sabroson");
    expect(profile).toMatchObject({
      id: BUSINESS_ID,
      name: "Sabrosón",
      slug: "sabroson",
      isActive: true,
      imageUrl: null,
      currencyCode: "ARS",
      isOpen: true,
      tagline: "Pizza y empanadas"
    });
    expect(profile?.businessHours).toHaveLength(1);
  });
});

describe("getPublicStorefrontHours / fulfillment / payment-methods", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedBusinessFind.mockResolvedValue(baseBusiness());
    mockedHoursFind.mockResolvedValue([]);
    mockedOpenInfo.mockResolvedValue({
      isOpen: false,
      nextOpenText: "Lunes a las 11:00 hs"
    });
    mockedConfigFind.mockResolvedValue({
      orders_enabled: true,
      checkout_enabled: true,
      delivery_enabled: true,
      takeaway_enabled: true,
      external_delivery_enabled: false,
      pickup_instructions: "Mostrador",
      orders_when_closed: false,
      operate_when_closed: false
    });
    mockedPaymentFind.mockResolvedValue([
      {
        id: "pm1",
        payment_method: "cash",
        label: "Efectivo",
        adjustment_type: "NONE",
        adjustment_value: new Prisma.Decimal(0),
        is_surcharge: false,
        instructions: null,
        sort_order: 0,
        bank_alias: null,
        bank_cbu: null,
        bank_holder: null
      }
    ]);
  });

  it("hours incluye isOpen", async () => {
    const hours = await getPublicStorefrontHours("sabroson");
    expect(hours).toMatchObject({
      isOpen: false,
      nextOpenText: "Lunes a las 11:00 hs",
      timezone: "America/Argentina/Buenos_Aires"
    });
  });

  it("fulfillment expone flags de delivery/takeaway", async () => {
    const fulfillment = await getPublicStorefrontFulfillment("sabroson");
    expect(fulfillment).toMatchObject({
      deliveryEnabled: true,
      takeawayEnabled: true,
      checkoutEnabled: true,
      pickupInstructions: "Mostrador"
    });
  });

  it("payment-methods solo activos", async () => {
    const result = await getPublicStorefrontPaymentMethods("sabroson");
    expect(result?.paymentMethods).toEqual([
      expect.objectContaining({ paymentMethod: "cash", label: "Efectivo" })
    ]);
    expect(mockedPaymentFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          business_id: BUSINESS_ID,
          is_active: true,
          payment_method: "cash"
        }
      })
    );
    expect(result).toMatchObject({ collectionMode: "pay_at_counter" });
  });
});

describe("listPublicMenuCategories / items", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedBusinessFind.mockResolvedValue(baseBusiness());
    mockedCategoryFind.mockResolvedValue([
      {
        id: "cat1",
        name: "Pizzas",
        description: null,
        position: 0,
        category_tag: "MAIN"
      }
    ]);
    mockedItemFind.mockResolvedValue([
      {
        id: "item1",
        name: "Muzza",
        description: "Clásica",
        image: "https://cdn/muzza.jpg",
        is_available: true,
        is_featured: true,
        category_id: "cat1",
        discount_type: null,
        discount_value: null,
        variations: ["Grande"],
        menu_item_price: [
          {
            id: "price1",
            currency_code: "ARS",
            amount: new Prisma.Decimal("4500.00")
          }
        ]
      }
    ]);
  });

  it("categorías con tag y position", async () => {
    const result = await listPublicMenuCategories("sabroson");
    expect(result?.categories).toEqual([
      {
        id: "cat1",
        name: "Pizzas",
        description: null,
        tag: "MAIN",
        position: 0
      }
    ]);
  });

  it("ítems alineados al mock de UI", async () => {
    const result = await listPublicMenuItems({ slugOrId: "sabroson" });
    expect(result?.items[0]).toMatchObject({
      id: "item1",
      name: "Muzza",
      description: "Clásica",
      price: "4500.00",
      currencyCode: "ARS",
      imageUrl: "https://cdn/muzza.jpg",
      categoryId: "cat1",
      available: true,
      featured: true,
      variations: ["Grande"],
      discount: null
    });
  });

  it("filtra por categoryId y availableOnly=false", async () => {
    await listPublicMenuItems({
      slugOrId: "sabroson",
      categoryId: "cat1",
      availableOnly: false
    });
    expect(mockedItemFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          business_id: BUSINESS_ID,
          category_id: "cat1"
        })
      })
    );
    const where = mockedItemFind.mock.calls[0][0].where;
    expect(where.is_available).toBeUndefined();
  });
});
