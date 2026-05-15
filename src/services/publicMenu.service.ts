import {
  activePriceSelect,
  getBusinessCurrencyCode,
  toMenuItemPriceDto
} from "../helpers/menuItemPrice.helper";
import { prisma } from "../lib/prisma";

export async function getPublicBusinessInfo(params: { businessId: string }) {
  const row = await prisma.business.findFirst({
    where: { id: params.businessId, is_active: true },
    select: {
      id: true,
      name: true,
      description: true,
      slug: true,
      timezone: true,
      currency_code: true,
      whatsapp_phone_number: true,
      latitude: true,
      longitude: true,
      business_hours: {
        orderBy: { day_of_week: "asc" },
        select: {
          id: true,
          day_of_week: true,
          opens_at: true,
          closes_at: true,
          is_closed: true
        }
      }
    }
  });

  if (!row) return null;

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    slug: row.slug ?? null,
    timezone: row.timezone,
    currencyCode: row.currency_code ?? null,
    whatsappPhoneNumber: row.whatsapp_phone_number ?? null,
    location:
      row.latitude !== null && row.longitude !== null
        ? { latitude: row.latitude, longitude: row.longitude }
        : null,
    businessHours: row.business_hours.map((h) => ({
      id: h.id,
      dayOfWeek: h.day_of_week,
      opensAt: h.opens_at,
      closesAt: h.closes_at,
      isClosed: h.is_closed
    }))
  };
}

function mapPublicMenuItem(row: {
  id: string;
  name: string;
  description: string | null;
  ingredients: string | null;
  preparation: string | null;
  image: string | null;
  serves_people: number | null;
  is_featured: boolean;
  menu_category: {
    id: string;
    name: string;
    category_tag: string;
  } | null;
  menu_item_price: Array<{
    id: string;
    currency_code: string;
    amount: import("@prisma/client").Prisma.Decimal;
  }>;
}) {
  const activePrice = row.menu_item_price[0];

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    ingredients: row.ingredients ?? null,
    preparation: row.preparation ?? null,
    image: row.image ?? null,
    servesPeople: row.serves_people ?? null,
    isFeatured: row.is_featured,
    category: row.menu_category
      ? {
          id: row.menu_category.id,
          name: row.menu_category.name,
          tag: row.menu_category.category_tag
        }
      : null,
    price: activePrice ? toMenuItemPriceDto(activePrice) : null,
    prices: activePrice ? [toMenuItemPriceDto(activePrice)] : []
  };
}

export async function listFeaturedMenuItems(params: {
  businessId: string;
  limit: number;
}) {
  const currencyCode = await getBusinessCurrencyCode(params.businessId);

  const rows = await prisma.menu_item.findMany({
    where: {
      business_id: params.businessId,
      is_featured: true,
      is_available: true
    },
    orderBy: { created_at: "desc" },
    take: params.limit,
    select: {
      id: true,
      name: true,
      description: true,
      ingredients: true,
      preparation: true,
      image: true,
      serves_people: true,
      is_featured: true,
      menu_category: {
        select: {
          id: true,
          name: true,
          category_tag: true
        }
      },
      menu_item_price: activePriceSelect(currencyCode)
    }
  });

  return rows.map(mapPublicMenuItem);
}

export async function getPublicMenuItemById(params: {
  businessId: string;
  itemId: string;
}) {
  const currencyCode = await getBusinessCurrencyCode(params.businessId);

  const row = await prisma.menu_item.findFirst({
    where: {
      id: params.itemId,
      business_id: params.businessId,
      is_available: true
    },
    select: {
      id: true,
      name: true,
      description: true,
      ingredients: true,
      preparation: true,
      image: true,
      serves_people: true,
      is_featured: true,
      menu_category: {
        select: {
          id: true,
          name: true,
          category_tag: true
        }
      },
      menu_item_price: activePriceSelect(currencyCode)
    }
  });

  if (!row) {
    return null;
  }

  return mapPublicMenuItem(row);
}
