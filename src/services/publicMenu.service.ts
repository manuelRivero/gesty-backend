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

export async function listFeaturedMenuItems(params: {
  businessId: string;
  limit: number;
}) {
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
      image: true,
      serves_people: true,
      menu_category: {
        select: {
          id: true,
          name: true,
          category_tag: true
        }
      },
      menu_item_price: {
        where: { is_active: true, valid_to: null },
        select: {
          id: true,
          currency_code: true,
          amount: true
        },
        orderBy: { amount: "asc" }
      }
    }
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    image: row.image ?? null,
    servesPeople: row.serves_people ?? null,
    category: row.menu_category
      ? {
          id: row.menu_category.id,
          name: row.menu_category.name,
          tag: row.menu_category.category_tag
        }
      : null,
    prices: row.menu_item_price.map((p) => ({
      id: p.id,
      currencyCode: p.currency_code,
      amount: p.amount
    }))
  }));
}
