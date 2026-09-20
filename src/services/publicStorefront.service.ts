import {
  activePriceSelect,
  getBusinessCurrencyCode,
  resolveEffectivePrice,
  toMenuItemPriceDto
} from "../helpers/menuItemPrice.helper";
import { prisma } from "../lib/prisma";
import { getBusinessOpenInfo } from "./businessHours.service";
import { buildGoogleMapsUrl } from "../utils/googleMapsUrl";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function looksLikeUuid(value: string): boolean {
  return UUID_RE.test(value);
}

type PublicBusinessRow = {
  id: string;
  name: string;
  description: string | null;
  slug: string | null;
  timezone: string;
  currency_code: string | null;
  whatsapp_phone_number: string | null;
  street_address: string | null;
  address_notes: string | null;
  latitude: number | null;
  longitude: number | null;
};

/**
 * Resuelve un local activo por slug (preferido) o UUID (compat).
 * Inactivo / inexistente / storefront_enabled=false → null (404 "local no disponible").
 */
export async function resolveActivePublicBusiness(
  slugOrId: string
): Promise<PublicBusinessRow | null> {
  const key = slugOrId.trim();
  if (!key) return null;

  const select = {
    id: true,
    name: true,
    description: true,
    slug: true,
    timezone: true,
    currency_code: true,
    whatsapp_phone_number: true,
    street_address: true,
    address_notes: true,
    latitude: true,
    longitude: true
  } as const;

  const storefrontOn = {
    business_config: { is: { storefront_enabled: true } }
  };

  if (looksLikeUuid(key)) {
    return prisma.business.findFirst({
      where: { id: key, is_active: true, ...storefrontOn },
      select
    });
  }

  return prisma.business.findFirst({
    where: { slug: key, is_active: true, ...storefrontOn },
    select
  });
}

function mapBusinessProfile(
  row: PublicBusinessRow,
  open: { isOpen: boolean; nextOpenText: string | null },
  hours: Array<{
    id: string;
    dayOfWeek: number;
    opensAt: string;
    closesAt: string;
    isClosed: boolean;
  }>
) {
  const mapsUrl = buildGoogleMapsUrl({
    name: row.name,
    streetAddress: row.street_address,
    latitude: row.latitude,
    longitude: row.longitude
  });

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    /** Tagline = description hasta que exista campo propio. */
    tagline: row.description ?? null,
    slug: row.slug ?? null,
    isActive: true as const,
    /** Logo de negocio aún no modelado en schema. */
    imageUrl: null as string | null,
    timezone: row.timezone,
    currencyCode: row.currency_code ?? null,
    whatsappPhoneNumber: row.whatsapp_phone_number ?? null,
    streetAddress: row.street_address ?? null,
    addressNotes: row.address_notes ?? null,
    mapsUrl,
    location:
      row.latitude !== null && row.longitude !== null
        ? {
            latitude: row.latitude,
            longitude: row.longitude,
            mapsUrl
          }
        : null,
    isOpen: open.isOpen,
    nextOpenText: open.nextOpenText,
    businessHours: hours
  };
}

async function loadBusinessHours(businessId: string) {
  const rows = await prisma.business_hours.findMany({
    where: { business_id: businessId },
    orderBy: { day_of_week: "asc" },
    select: {
      id: true,
      day_of_week: true,
      opens_at: true,
      closes_at: true,
      is_closed: true
    }
  });

  return rows.map((h) => ({
    id: h.id,
    dayOfWeek: h.day_of_week,
    opensAt: h.opens_at,
    closesAt: h.closes_at,
    isClosed: h.is_closed
  }));
}

export async function getPublicStorefrontProfile(slugOrId: string) {
  const row = await resolveActivePublicBusiness(slugOrId);
  if (!row) return null;

  const [open, hours] = await Promise.all([
    getBusinessOpenInfo({ businessId: row.id, timezone: row.timezone }),
    loadBusinessHours(row.id)
  ]);

  return mapBusinessProfile(row, open, hours);
}

export async function getPublicStorefrontHours(slugOrId: string) {
  const row = await resolveActivePublicBusiness(slugOrId);
  if (!row) return null;

  const [open, hours] = await Promise.all([
    getBusinessOpenInfo({ businessId: row.id, timezone: row.timezone }),
    loadBusinessHours(row.id)
  ]);

  return {
    timezone: row.timezone,
    isOpen: open.isOpen,
    nextOpenText: open.nextOpenText,
    businessHours: hours
  };
}

export async function getPublicStorefrontFulfillment(slugOrId: string) {
  const row = await resolveActivePublicBusiness(slugOrId);
  if (!row) return null;

  const config = await prisma.business_config.findUnique({
    where: { business_id: row.id },
    select: {
      orders_enabled: true,
      checkout_enabled: true,
      delivery_enabled: true,
      takeaway_enabled: true,
      external_delivery_enabled: true,
      pickup_instructions: true,
      orders_when_closed: true,
      operate_when_closed: true
    }
  });

  return {
    ordersEnabled: config?.orders_enabled ?? false,
    checkoutEnabled: config?.checkout_enabled ?? false,
    /** Propio o externo: mismo criterio que el bot (excluyentes en config). */
    deliveryEnabled: Boolean(
      config?.delivery_enabled || config?.external_delivery_enabled
    ),
    takeawayEnabled: config?.takeaway_enabled ?? false,
    /** Detalle del modo; deliveryEnabled ya lo incluye. */
    externalDeliveryEnabled: config?.external_delivery_enabled ?? false,
    pickupInstructions: config?.pickup_instructions ?? null,
    ordersWhenClosed: config?.orders_when_closed ?? false,
    operateWhenClosed: config?.operate_when_closed ?? false,
    /** Viewport del mapa de pin (origen del local). Null → front usa default ciudad. */
    mapCenter:
      row.latitude !== null && row.longitude !== null
        ? { latitude: row.latitude, longitude: row.longitude }
        : null
  };
}

export async function getPublicStorefrontPaymentMethods(slugOrId: string) {
  const row = await resolveActivePublicBusiness(slugOrId);
  if (!row) return null;

  // Storefront = cobro manual en mostrador. Online/MP y transfer quedan
  // exclusivos del flujo WhatsApp; acá solo se publica cash.
  const rows = await prisma.payment_method_config.findMany({
    where: {
      business_id: row.id,
      is_active: true,
      payment_method: "cash"
    },
    orderBy: [{ sort_order: "asc" }, { payment_method: "asc" }],
    select: {
      id: true,
      payment_method: true,
      label: true,
      adjustment_type: true,
      adjustment_value: true,
      is_surcharge: true,
      instructions: true,
      sort_order: true,
      bank_alias: true,
      bank_cbu: true,
      bank_holder: true
    }
  });

  return {
    paymentMethods: rows.map((r) => ({
      id: r.id,
      paymentMethod: r.payment_method,
      label: r.label,
      adjustmentType: r.adjustment_type,
      adjustmentValue: Number(r.adjustment_value),
      isSurcharge: r.is_surcharge,
      instructions: r.instructions,
      sortOrder: r.sort_order,
      bankAlias: r.bank_alias,
      bankCbu: r.bank_cbu,
      bankHolder: r.bank_holder
    })),
    /** Siempre cobro en mostrador; el POST ignora otros métodos. */
    collectionMode: "pay_at_counter" as const
  };
}

export async function listPublicMenuCategories(slugOrId: string) {
  const row = await resolveActivePublicBusiness(slugOrId);
  if (!row) return null;

  const categories = await prisma.menu_category.findMany({
    where: { business_id: row.id, is_active: true },
    orderBy: [{ position: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      position: true,
      category_tag: true
    }
  });

  return {
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description ?? null,
      tag: c.category_tag,
      position: c.position
    }))
  };
}

type StorefrontMenuItemRow = {
  id: string;
  name: string;
  description: string | null;
  image: string | null;
  is_available: boolean;
  is_featured: boolean;
  category_id: string;
  discount_type: string | null;
  discount_value: import("@prisma/client").Prisma.Decimal | null;
  variations: string[];
  menu_item_price: Array<{
    id: string;
    currency_code: string;
    amount: import("@prisma/client").Prisma.Decimal;
  }>;
};

function mapStorefrontMenuItem(row: StorefrontMenuItemRow) {
  const activePrice = row.menu_item_price[0];
  const resolved = resolveEffectivePrice(row);
  const priceDto = activePrice ? toMenuItemPriceDto(activePrice) : null;

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    price: priceDto ? priceDto.amount : null,
    currencyCode: priceDto ? priceDto.currencyCode : null,
    imageUrl: row.image ?? null,
    categoryId: row.category_id,
    available: row.is_available,
    featured: row.is_featured,
    variations: row.variations.length > 0 ? row.variations : null,
    discount: resolved.hasDiscount
      ? {
          discountType: row.discount_type as "PERCENT" | "FIXED",
          discountValue: row.discount_value ? Number(row.discount_value) : null,
          discountAmount: resolved.discountAmount.toFixed(2),
          finalPrice: resolved.finalPrice.toFixed(2)
        }
      : null
  };
}

export async function listPublicMenuItems(params: {
  slugOrId: string;
  categoryId?: string;
  availableOnly?: boolean;
}) {
  const row = await resolveActivePublicBusiness(params.slugOrId);
  if (!row) return null;

  const availableOnly = params.availableOnly !== false;
  const currencyCode = await getBusinessCurrencyCode(row.id);

  const items = await prisma.menu_item.findMany({
    where: {
      business_id: row.id,
      ...(availableOnly ? { is_available: true } : {}),
      ...(params.categoryId ? { category_id: params.categoryId } : {}),
      menu_category: { is_active: true }
    },
    orderBy: [{ name: "asc" }],
    select: {
      id: true,
      name: true,
      description: true,
      image: true,
      is_available: true,
      is_featured: true,
      category_id: true,
      discount_type: true,
      discount_value: true,
      variations: true,
      menu_item_price: activePriceSelect(currencyCode)
    }
  });

  return { items: items.map(mapStorefrontMenuItem) };
}

export async function getPublicStorefrontMenu(params: {
  slugOrId: string;
  availableOnly?: boolean;
}) {
  const business = await getPublicStorefrontProfile(params.slugOrId);
  if (!business) return null;

  const [categoriesResult, itemsResult] = await Promise.all([
    listPublicMenuCategories(params.slugOrId),
    listPublicMenuItems({
      slugOrId: params.slugOrId,
      availableOnly: params.availableOnly
    })
  ]);

  return {
    business,
    categories: categoriesResult?.categories ?? [],
    items: itemsResult?.items ?? []
  };
}
