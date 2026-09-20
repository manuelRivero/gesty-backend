import {
  activePriceSelect,
  getBusinessCurrencyCode,
  resolveEffectivePrice,
  toMenuItemPriceDto
} from "../helpers/menuItemPrice.helper";
import { prisma } from "../lib/prisma";
import {
  getPublicStorefrontProfile,
  resolveActivePublicBusiness
} from "./publicStorefront.service";

/** @deprecated Prefer getPublicStorefrontProfile; se mantiene por compat. */
export async function getPublicBusinessInfo(params: { businessId: string }) {
  return getPublicStorefrontProfile(params.businessId);
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
  discount_type: string | null;
  discount_value: import("@prisma/client").Prisma.Decimal | null;
  variations: string[];
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
  const resolved = resolveEffectivePrice(row);

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
    prices: activePrice ? [toMenuItemPriceDto(activePrice)] : [],
    discount: resolved.hasDiscount
      ? {
          discountType: row.discount_type as "PERCENT" | "FIXED",
          discountValue: row.discount_value ? Number(row.discount_value) : null,
          discountAmount: resolved.discountAmount.toFixed(2),
          finalPrice: resolved.finalPrice.toFixed(2)
        }
      : null,
    // [] ≡ null ≡ "sin variaciones" (D1).
    variations: row.variations.length > 0 ? row.variations : null
  };
}

export async function listFeaturedMenuItems(params: {
  businessId: string;
  limit: number;
}) {
  const business = await resolveActivePublicBusiness(params.businessId);
  if (!business) return [];

  const currencyCode = await getBusinessCurrencyCode(business.id);

  const rows = await prisma.menu_item.findMany({
    where: {
      business_id: business.id,
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
      discount_type: true,
      discount_value: true,
      variations: true,
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
  const business = await resolveActivePublicBusiness(params.businessId);
  if (!business) return null;

  const currencyCode = await getBusinessCurrencyCode(business.id);

  const row = await prisma.menu_item.findFirst({
    where: {
      id: params.itemId,
      business_id: business.id,
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
      discount_type: true,
      discount_value: true,
      variations: true,
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
