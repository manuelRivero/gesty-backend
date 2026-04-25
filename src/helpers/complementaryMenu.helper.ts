import type { MenuCategoryTag } from '@prisma/client';
import { prisma } from '../lib/prisma';

const MEANINGFUL_TAGS: ReadonlySet<MenuCategoryTag> = new Set([
  'STARTER',
  'MAIN',
  'SIDE',
  'DRINK',
  'DESSERT',
]);

/**
 * Orden para armar el menú de a un tag: entrada → principal → bebida → guarnición → postre.
 * Usado como guía para el LLM y como fallback determinístico.
 */
export const MENU_SUGGESTION_ORDER: MenuCategoryTag[] = [
  'STARTER',
  'MAIN',
  'DRINK',
  'SIDE',
  'DESSERT',
];

export type ComplementaryMenuItemSummary = {
  id: string;
  name: string;
  categoryTag: MenuCategoryTag;
  categoryName: string;
};

export type ComplementarySuggestionsResult = {
  /** Un solo tag por mensaje (o vacío si no hay sugerencia). */
  suggestedTags: MenuCategoryTag[];
  items: ComplementaryMenuItemSummary[];
};

/**
 * Tags del “menú completo” que aún no aparecen en el carrito, en orden sugerido.
 */
export function getMissingMenuTags(cartTags: Set<MenuCategoryTag>): MenuCategoryTag[] {
  return MENU_SUGGESTION_ORDER.filter((t) => !cartTags.has(t));
}

/** Siguiente tag si no hay IA: el primero de la lista faltante. */
export function pickFallbackNextTag(missingOrdered: MenuCategoryTag[]): MenuCategoryTag | null {
  return missingOrdered[0] ?? null;
}

/**
 * Tag de la categoría del ítem de menú. `OTHER` o categoría inactiva se trata como sin clasificar.
 */
export async function getMenuItemCategoryTag(
  menuItemId: string,
  businessId: string
): Promise<MenuCategoryTag | null> {
  const row = await prisma.menu_item.findFirst({
    where: {
      id: menuItemId,
      business_id: businessId,
      is_available: true,
    },
    select: {
      menu_category: {
        select: { category_tag: true, is_active: true },
      },
    },
  });
  if (!row?.menu_category?.is_active) return null;
  const tag = row.menu_category.category_tag;
  return tag === 'OTHER' ? null : tag;
}

/**
 * Conjunto de tags presentes en el carrito borrador (una vez por línea, según categoría del producto).
 */
export async function collectCategoryTagsInDraftCart(
  draftOrderId: string,
  businessId: string
): Promise<Set<MenuCategoryTag>> {
  const lines = await prisma.draft_order_item.findMany({
    where: {
      draft_order_id: draftOrderId,
      product_id: { not: null },
      menu_item: {
        business_id: businessId,
      },
    },
    select: {
      menu_item: {
        select: {
          menu_category: {
            select: { category_tag: true, is_active: true },
          },
        },
      },
    },
  });

  const tags = new Set<MenuCategoryTag>();
  for (const line of lines) {
    const cat = line.menu_item?.menu_category;
    if (!cat?.is_active) continue;
    const t = cat.category_tag;
    if (MEANINGFUL_TAGS.has(t)) tags.add(t);
  }
  return tags;
}

export type FetchComplementaryItemsParams = {
  businessId: string;
  tags: MenuCategoryTag[];
  excludeProductIds: string[];
  limit?: number;
};

/**
 * Busca productos disponibles en categorías con los tags indicados.
 */
export async function fetchComplementaryMenuItems(
  params: FetchComplementaryItemsParams
): Promise<ComplementaryMenuItemSummary[]> {
  const { businessId, tags, excludeProductIds, limit = 8 } = params;
  if (tags.length === 0) return [];

  const distinctTags = [...new Set(tags)];

  const rows = await prisma.menu_item.findMany({
    where: {
      business_id: businessId,
      is_available: true,
      id: excludeProductIds.length ? { notIn: excludeProductIds } : undefined,
      menu_category: {
        is_active: true,
        category_tag: { in: distinctTags },
      },
    },
    select: {
      id: true,
      name: true,
      is_featured: true,
      menu_category: {
        select: { name: true, category_tag: true },
      },
    },
    orderBy: [{ is_featured: 'desc' }, { name: 'asc' }],
    take: limit,
  });

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    categoryTag: r.menu_category.category_tag,
    categoryName: r.menu_category.name,
  }));
}

export type BuildComplementarySuggestionsParams = {
  businessId: string;
  draftOrderId: string;
  lastAddedMenuItemId: string;
  maxItems?: number;
};
