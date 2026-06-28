/**
 * Tools LangChain para la **fase 2 (hybrid agent)**.
 *
 * Cada tool envuelve un servicio existente del repo sin modificar su firma
 * ni su comportamiento. El ReactAgent puede invocarlos por nombre cuando
 * razona sobre intents NLP libres (ORDER_FOOD, PRODUCT_QUERY, FALLBACK).
 *
 * Restricciones intencionales:
 * - No exponemos tools de escritura críticas (checkout, addItem real) hasta
 *   tener guardas; las tools de carrito devuelven snapshots, no mutan.
 * - `searchProducts` reutiliza la búsqueda por keyword del menú (la misma que
 *   hoy alimenta `productQuery/service.ts`).
 * - `getRecentMessages` devuelve contexto conversacional para que el agente
 *   tenga memoria sobre el turno anterior.
 * - Los identificadores de negocio/cliente/conversación se inyectan server-side
 *   via `configurable` — nunca pasan por el schema del LLM (elimina riesgo
 *   cross-tenant).
 *
 * Uso: ver `src/agents/reactAgent.ts`.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { RunnableConfig } from '@langchain/core/runnables';
import { Prisma } from '@prisma/client';
import { MenuService } from '../services/menu.service';
import { getBusinessOpenInfo } from '../services/businessHours.service';
import { findRecentMessagesForDetectionContext } from '../repositories';
import { prisma } from '../lib/prisma';
import { buildGoogleMapsUrl } from '../utils/googleMapsUrl';
import {
  fetchComplementaryMenuItems,
  getMenuItemCategoryTag,
  MENU_SUGGESTION_ORDER,
} from '../helpers/complementaryMenu.helper';
import { getReactContext } from './_context';
import { createOnlinePaymentLink } from '../services/payment/payment.service';
import { refreshDraftOrderTimeout } from '../services/draftOrderTimeout.service';
import { resolveEffectivePrice } from '../helpers/menuItemPrice.helper';
import { listPaymentAdjustmentsForAmount } from '../services/paymentAdjustment.service';
import { computeOrderPricing } from '../services/pricing.service';

const toJson = (data: unknown): string => {
  try {
    return JSON.stringify(data, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
  } catch {
    return JSON.stringify({ error: 'unserializable_result' });
  }
};

const PRODUCT_SHORTLIST_MAX_LIMIT = 12;

const toShortlistItem = (item: {
  id: string;
  name: string;
  serves_people: number | null;
  is_featured?: boolean;
  menu_category?: { id: string; name: string; category_tag: string | null } | null;
  menu_item_price?: Array<{ amount: Prisma.Decimal; currency_code: string }> | null;
}) => {
  const firstPrice = item.menu_item_price?.[0];
  return {
    id: item.id,
    name: item.name,
    serves_people: item.serves_people,
    is_featured: item.is_featured ?? false,
    category: item.menu_category
      ? {
          id: item.menu_category.id,
          name: item.menu_category.name,
          tag: item.menu_category.category_tag,
        }
      : null,
    price: firstPrice
      ? {
          amount: firstPrice.amount.toString(),
          currency: firstPrice.currency_code,
        }
      : null,
  };
};

// ---------------------------------------------------------------------------
// search_products
// ---------------------------------------------------------------------------

const searchProductsSchema = z.object({
  keyword: z.string().min(1).describe('Palabra clave o nombre a buscar'),
});
type SearchProductsInput = z.infer<typeof searchProductsSchema>;

export const searchProductsTool = new DynamicStructuredTool<
  typeof searchProductsSchema,
  SearchProductsInput
>({
  name: 'search_products',
  description:
    'Busca productos del menú por palabra clave (nombre o ingrediente). Devuelve shortlist liviano (id, nombre, categoría, porciones y precio principal). Si necesitás más detalle por producto, usá get_products_details_by_ids.',
  schema: searchProductsSchema,
  func: async ({ keyword }: SearchProductsInput, _runManager, config?: RunnableConfig) => {
    const { businessId } = getReactContext(config);
    const items = await MenuService.searchMenuItemsByKeyword({ businessId, keyword });
    const shortlisted = items.slice(0, PRODUCT_SHORTLIST_MAX_LIMIT);
    return toJson({
      count: shortlisted.length,
      totalMatches: items.length,
      hasMore: items.length > shortlisted.length,
      items: shortlisted.map((item) => toShortlistItem(item)),
    });
  },
});

// ---------------------------------------------------------------------------
// get_categories
// ---------------------------------------------------------------------------

const getCategoriesSchema = z.object({});
type GetCategoriesInput = z.infer<typeof getCategoriesSchema>;

export const getCategoriesTool = new DynamicStructuredTool<
  typeof getCategoriesSchema,
  GetCategoriesInput
>({
  name: 'get_categories',
  description: 'Devuelve la lista de categorías de menú visibles para el cliente.',
  schema: getCategoriesSchema,
  func: async (_input: GetCategoriesInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerId } = getReactContext(config);
    const res = await MenuService.getCategoryListForCustomer({ businessId, customerId });
    return toJson({
      text: res.text,
      categories: res.buttons.map((b) => ({ title: b.title, payload: b.payload })),
    });
  },
});

// ---------------------------------------------------------------------------
// get_menu_by_category
// ---------------------------------------------------------------------------

const getMenuByCategorySchema = z.object({
  categoryId: z.string().describe('UUID de la categoría'),
});
type GetMenuByCategoryInput = z.infer<typeof getMenuByCategorySchema>;

export const getMenuByCategoryTool = new DynamicStructuredTool<
  typeof getMenuByCategorySchema,
  GetMenuByCategoryInput
>({
  name: 'get_menu_by_category',
  description: 'Devuelve los items del menú de una categoría específica (lectura).',
  schema: getMenuByCategorySchema,
  func: async ({ categoryId }: GetMenuByCategoryInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerId } = getReactContext(config);
    const res = await MenuService.getItemsByCategory({ businessId, customerId, categoryId });
    return toJson({
      text: res.text,
      items: res.buttons.map((b) => ({ title: b.title, payload: b.payload })),
    });
  },
});

// ---------------------------------------------------------------------------
// get_cart
// ---------------------------------------------------------------------------

const getCartSchema = z.object({});
type GetCartInput = z.infer<typeof getCartSchema>;

export const getCartTool = new DynamicStructuredTool<
  typeof getCartSchema,
  GetCartInput
>({
  name: 'get_cart',
  description:
    'Devuelve el contenido del carrito activo (draft order) del cliente, sin modificarlo. ' +
    'Incluye precios con descuento por producto y ajustes estimados según método de pago.',
  schema: getCartSchema,
  func: async (_input: GetCartInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone, customerId } = getReactContext(config);
    const draft = await prisma.draft_order.findFirst({
      where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
      include: {
        draft_order_item: {
          include: { menu_item: { select: { id: true, name: true } } },
        },
      },
    });

    if (!draft) {
      return toJson({ exists: false, items: [] });
    }

    const pricing = computeOrderPricing(draft.draft_order_item);
    const itemsTotal = pricing.subtotal - pricing.productDiscounts;

    // Ajustes estimados por método de pago (sin aplicar delivery fee en esta preview)
    const paymentAdjustments = await listPaymentAdjustmentsForAmount({
      businessId,
      baseAmount: itemsTotal,
    });

    return toJson({
      exists: true,
      draftOrderId: draft.id,
      expiresAt: draft.expires_at?.toISOString() ?? null,
      fulfillmentType: draft.fulfillment_type ?? null,
      items: draft.draft_order_item.map((it) => ({
        id: it.id,
        productId: it.product_id,
        menuItemName: it.menu_item?.name ?? null,
        quantity: it.quantity,
        unitPrice: it.unit_price.toString(),
        totalPrice: it.total_price.toString(),
        notes: it.notes ?? null,
        ...(it.list_price && {
          listPrice: it.list_price.toString(),
          discountAmount: it.discount_amount?.toString() ?? null,
        }),
      })),
      pricing: {
        itemsSubtotal: pricing.subtotal.toFixed(2),
        productDiscounts: pricing.productDiscounts > 0
          ? pricing.productDiscounts.toFixed(2)
          : null,
        itemsTotal: itemsTotal.toFixed(2),
        note: draft.fulfillment_type === 'DELIVERY'
          ? 'El costo de envío se agrega al confirmar según tu zona de cobertura.'
          : null,
      },
      paymentOptions: paymentAdjustments.length > 0
        ? paymentAdjustments.map((a) => ({
            method: a.paymentMethod,
            label: a.label,
            adjustment: a.adjustmentAmount.toFixed(2),
            finalAmount: a.finalAmount.toFixed(2),
            isSurcharge: a.isSurcharge,
          }))
        : null,
    });
  },
});

// ---------------------------------------------------------------------------
// get_business_hours
// ---------------------------------------------------------------------------

const getBusinessHoursSchema = z.object({});
type GetBusinessHoursInput = z.infer<typeof getBusinessHoursSchema>;

export const getBusinessHoursTool = new DynamicStructuredTool<
  typeof getBusinessHoursSchema,
  GetBusinessHoursInput
>({
  name: 'get_business_hours',
  description: 'Devuelve si el negocio está abierto ahora y los horarios del día actual / próximo.',
  schema: getBusinessHoursSchema,
  func: async (_input: GetBusinessHoursInput, _runManager, config?: RunnableConfig) => {
    const { businessId } = getReactContext(config);
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, timezone: true },
    });
    if (!business?.timezone) {
      return toJson({ error: 'business_timezone_missing' });
    }
    const info = await getBusinessOpenInfo({ businessId: business.id, timezone: business.timezone });
    return toJson(info);
  },
});

// ---------------------------------------------------------------------------
// get_recent_messages
// ---------------------------------------------------------------------------

const getRecentMessagesSchema = z.object({
  take: z.number().int().positive().max(50).default(10),
});
type GetRecentMessagesInput = z.infer<typeof getRecentMessagesSchema>;

export const getRecentMessagesTool = new DynamicStructuredTool<
  typeof getRecentMessagesSchema,
  GetRecentMessagesInput
>({
  name: 'get_recent_messages',
  description:
    'Devuelve los últimos N mensajes de la conversación (más recientes primero).',
  schema: getRecentMessagesSchema,
  func: async ({ take }: GetRecentMessagesInput, _runManager, config?: RunnableConfig) => {
    const { conversationId, conversationStartedAt } = getReactContext(config);
    const since = new Date(conversationStartedAt);
    const messages = await findRecentMessagesForDetectionContext(conversationId, since, take);
    return toJson(
      messages.map((m) => ({
        id: m.id,
        sender: m.sender,
        message: m.message,
        isAi: m.is_ai_generated,
        createdAt: m.created_at.toISOString(),
      }))
    );
  },
});

// ---------------------------------------------------------------------------
// get_featured_products
// ---------------------------------------------------------------------------

const getFeaturedProductsSchema = z.object({
  currencyCode: z.string().nullable().optional(),
  limit: z.number().int().positive().max(20).default(8),
});
type GetFeaturedProductsInput = z.infer<typeof getFeaturedProductsSchema>;

export const getFeaturedProductsTool = new DynamicStructuredTool<
  typeof getFeaturedProductsSchema,
  GetFeaturedProductsInput
>({
  name: 'get_featured_products',
  description:
    'Devuelve los productos destacados del negocio (menu_item.is_featured = true), con precio activo cuando exista.',
  schema: getFeaturedProductsSchema,
  func: async (
    { currencyCode, limit }: GetFeaturedProductsInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { businessId } = getReactContext(config);
    const items = await MenuService.getFeaturedMenuItems({
      businessId,
      currencyCode: currencyCode ?? null,
      limit,
    });
    return toJson({
      count: items.length,
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        ingredients: item.ingredients,
        serves_people: item.serves_people,
        is_available: item.is_available,
        prices: item.menu_item_price.map((p) => ({
          amount: p.amount.toString(),
          currency: p.currency_code,
        })),
      })),
    });
  },
});

// ---------------------------------------------------------------------------
// find_products_by_filter
// ---------------------------------------------------------------------------

const MENU_CATEGORY_TAGS = ['STARTER', 'MAIN', 'SIDE', 'DRINK', 'DESSERT', 'OTHER'] as const;

const findProductsByFilterSchema = z.object({
  categoryTag: z
    .enum(MENU_CATEGORY_TAGS)
    .nullable()
    .optional()
    .describe('Rol de la categoría (STARTER, MAIN, SIDE, DRINK, DESSERT, OTHER).'),
  categoryId: z
    .string()
    .nullable()
    .optional()
    .describe('UUID de una categoría específica del menú (opcional).'),
  containsIngredient: z
    .string()
    .nullable()
    .optional()
    .describe('Substring que DEBE aparecer en el nombre o ingredientes (case-insensitive).'),
  excludesIngredient: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Substring que NO debe aparecer en el nombre ni en los ingredientes (case-insensitive). Útil para alergias o "sin X".'
    ),
  minServesPeople: z
    .number()
    .int()
    .positive()
    .nullable()
    .optional()
    .describe('Mínimo de personas que sirve el plato (serves_people >= N).'),
  minPrice: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe('Precio mínimo (en la moneda solicitada o la del negocio).'),
  maxPrice: z
    .number()
    .nonnegative()
    .nullable()
    .optional()
    .describe('Precio máximo (en la moneda solicitada o la del negocio).'),
  currencyCode: z
    .string()
    .nullable()
    .optional()
    .describe('Código de moneda ISO (ej. "ARS"). Si no se pasa, usa la del negocio.'),
  featuredOnly: z
    .boolean()
    .nullable()
    .optional()
    .describe('Si true, solo devuelve productos destacados (is_featured = true).'),
  limit: z.number().int().positive().max(PRODUCT_SHORTLIST_MAX_LIMIT).default(10),
});
type FindProductsByFilterInput = z.infer<typeof findProductsByFilterSchema>;

export const findProductsByFilterTool = new DynamicStructuredTool<
  typeof findProductsByFilterSchema,
  FindProductsByFilterInput
>({
  name: 'find_products_by_filter',
  description:
    'Busca productos del menú aplicando filtros estructurados (categoría, rol de categoría, ingredientes, porciones, rango de precio, destacados). Devuelve shortlist liviano para decidir rápido. Si necesitás descripción/ingredientes detallados, usá get_products_details_by_ids con los IDs elegidos.',
  schema: findProductsByFilterSchema,
  func: async (
    {
      categoryTag,
      categoryId,
      containsIngredient,
      excludesIngredient,
      minServesPeople,
      minPrice,
      maxPrice,
      currencyCode,
      featuredOnly,
      limit,
    }: FindProductsByFilterInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { businessId } = getReactContext(config);
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { currency_code: true },
    });
    const currency = currencyCode ?? business?.currency_code ?? null;
    const now = new Date();

    const priceWhere: Prisma.menu_item_priceWhereInput = {
      is_active: true,
      valid_from: { lte: now },
      OR: [{ valid_to: null }, { valid_to: { gte: now } }],
      ...(currency ? { currency_code: currency } : {}),
      ...(minPrice != null || maxPrice != null
        ? {
            amount: {
              ...(minPrice != null ? { gte: minPrice } : {}),
              ...(maxPrice != null ? { lte: maxPrice } : {}),
            },
          }
        : {}),
    };

    const ingredientContains = containsIngredient?.trim();
    const ingredientExcludes = excludesIngredient?.trim();

    const where: Prisma.menu_itemWhereInput = {
      business_id: businessId,
      is_available: true,
      ...(featuredOnly ? { is_featured: true } : {}),
      ...(minServesPeople ? { serves_people: { gte: minServesPeople } } : {}),
      menu_category: {
        is_active: true,
        ...(categoryTag ? { category_tag: categoryTag } : {}),
      },
      ...(categoryId ? { category_id: categoryId } : {}),
      menu_item_price: { some: priceWhere },
      ...(ingredientContains
        ? {
            OR: [
              { name: { contains: ingredientContains, mode: 'insensitive' } },
              { ingredients: { contains: ingredientContains, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(ingredientExcludes
        ? {
            NOT: {
              OR: [
                { name: { contains: ingredientExcludes, mode: 'insensitive' } },
                { ingredients: { contains: ingredientExcludes, mode: 'insensitive' } },
              ],
            },
          }
        : {}),
    };

    const safeLimit = Math.max(1, Math.min(limit, PRODUCT_SHORTLIST_MAX_LIMIT));
    const [totalMatches, items] = await Promise.all([
      prisma.menu_item.count({ where }),
      prisma.menu_item.findMany({
        where,
        orderBy: [{ is_featured: 'desc' }, { name: 'asc' }],
        take: safeLimit,
        select: {
          id: true,
          name: true,
          serves_people: true,
          is_featured: true,
          menu_category: { select: { id: true, name: true, category_tag: true } },
          menu_item_price: {
            where: priceWhere,
            orderBy: { valid_from: 'desc' },
            take: 1,
            select: { amount: true, currency_code: true },
          },
        },
      }),
    ]);

    return toJson({
      count: items.length,
      totalMatches,
      hasMore: totalMatches > items.length,
      currencyApplied: currency,
      items: items.map((item) => toShortlistItem(item)),
    });
  },
});

// ---------------------------------------------------------------------------
// get_products_details_by_ids
// ---------------------------------------------------------------------------

const getProductsDetailsByIdsSchema = z.object({
  productIds: z
    .array(z.string().min(1))
    .min(1)
    .max(5)
    .describe('IDs de productos previamente seleccionados (max 5).'),
  currencyCode: z
    .string()
    .nullable()
    .optional()
    .describe('Código de moneda ISO (ej. "ARS"). Si no se pasa, usa la del negocio.'),
});
type GetProductsDetailsByIdsInput = z.infer<typeof getProductsDetailsByIdsSchema>;

export const getProductsDetailsByIdsTool = new DynamicStructuredTool<
  typeof getProductsDetailsByIdsSchema,
  GetProductsDetailsByIdsInput
>({
  name: 'get_products_details_by_ids',
  description:
    'Hidrata detalle completo SOLO para productos ya shortlistados (descripcion, ingredientes, porciones y precio activo). Usar despues de search_products/find_products_by_filter para evitar contexto excesivo.',
  schema: getProductsDetailsByIdsSchema,
  func: async (
    { productIds, currencyCode }: GetProductsDetailsByIdsInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { businessId } = getReactContext(config);
    const uniqueIds = Array.from(
      new Set(productIds.map((id) => id.trim()).filter(Boolean))
    );
    if (!uniqueIds.length) {
      return toJson({ count: 0, items: [] });
    }

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { currency_code: true },
    });
    const currency = currencyCode ?? business?.currency_code ?? null;
    const now = new Date();
    const priceWhere: Prisma.menu_item_priceWhereInput = {
      is_active: true,
      valid_from: { lte: now },
      OR: [{ valid_to: null }, { valid_to: { gte: now } }],
      ...(currency ? { currency_code: currency } : {}),
    };

    const items = await prisma.menu_item.findMany({
      where: {
        business_id: businessId,
        id: { in: uniqueIds.slice(0, 5) },
        is_available: true,
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        ingredients: true,
        serves_people: true,
        is_available: true,
        is_featured: true,
        menu_category: { select: { id: true, name: true, category_tag: true } },
        menu_item_price: {
          where: priceWhere,
          orderBy: { valid_from: 'desc' },
          take: 1,
          select: { amount: true, currency_code: true },
        },
      },
    });

    return toJson({
      count: items.length,
      currencyApplied: currency,
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        description: item.description,
        ingredients: item.ingredients,
        serves_people: item.serves_people,
        is_available: item.is_available,
        is_featured: item.is_featured,
        category: {
          id: item.menu_category.id,
          name: item.menu_category.name,
          tag: item.menu_category.category_tag,
        },
        prices: item.menu_item_price.map((p) => ({
          amount: p.amount.toString(),
          currency: p.currency_code,
        })),
      })),
    });
  },
});

// ---------------------------------------------------------------------------
// check_product_availability
// ---------------------------------------------------------------------------

const checkProductAvailabilitySchema = z
  .object({
    productId: z
      .string()
      .nullable()
      .optional()
      .describe('UUID exacto del producto (preferido si está disponible).'),
    productName: z
      .string()
      .nullable()
      .optional()
      .describe('Nombre del producto (búsqueda exacta o por substring case-insensitive).'),
  })
  .refine(
    (data) => Boolean(data.productId?.trim() || data.productName?.trim()),
    { message: 'Debe pasarse productId o productName.' }
  );
type CheckProductAvailabilityInput = z.infer<typeof checkProductAvailabilitySchema>;

export const checkProductAvailabilityTool = new DynamicStructuredTool<
  typeof checkProductAvailabilitySchema,
  CheckProductAvailabilityInput
>({
  name: 'check_product_availability',
  description:
    'Verifica si un producto del menú está disponible AHORA. Acepta productId o productName. Si pasa nombre y matchea con varios, devuelve hasta 5 candidatos para que el agente elija. Usar antes de prometer un plato al cliente.',
  schema: checkProductAvailabilitySchema,
  func: async (
    { productId, productName }: CheckProductAvailabilityInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { businessId } = getReactContext(config);
    const id = productId?.trim();
    const name = productName?.trim();

    const select = {
      id: true,
      name: true,
      is_available: true,
      menu_category: {
        select: { id: true, name: true, category_tag: true, is_active: true },
      },
    } satisfies Prisma.menu_itemSelect;

    if (id) {
      const item = await prisma.menu_item.findFirst({
        where: { id, business_id: businessId },
        select,
      });
      if (!item) {
        return toJson({ found: false, candidates: [] });
      }
      return toJson({
        found: true,
        candidates: [
          {
            id: item.id,
            name: item.name,
            isAvailable: item.is_available && item.menu_category.is_active,
            category: {
              id: item.menu_category.id,
              name: item.menu_category.name,
              tag: item.menu_category.category_tag,
            },
          },
        ],
      });
    }

    if (!name) {
      return toJson({ found: false, candidates: [] });
    }

    const candidates = await prisma.menu_item.findMany({
      where: {
        business_id: businessId,
        OR: [
          { name: { equals: name, mode: 'insensitive' } },
          { name: { contains: name, mode: 'insensitive' } },
        ],
      },
      orderBy: [{ is_available: 'desc' }, { is_featured: 'desc' }, { name: 'asc' }],
      take: 5,
      select,
    });

    return toJson({
      found: candidates.length > 0,
      candidates: candidates.map((item) => ({
        id: item.id,
        name: item.name,
        isAvailable: item.is_available && item.menu_category.is_active,
        category: {
          id: item.menu_category.id,
          name: item.menu_category.name,
          tag: item.menu_category.category_tag,
        },
      })),
    });
  },
});

// ---------------------------------------------------------------------------
// get_complementary_suggestions
// ---------------------------------------------------------------------------

const getComplementarySuggestionsSchema = z.object({
  productId: z
    .string()
    .nullable()
    .optional()
    .describe('UUID del producto base. Las sugerencias serán de las OTRAS categorías del menú.'),
  categoryTag: z
    .enum(['STARTER', 'MAIN', 'SIDE', 'DRINK', 'DESSERT'])
    .nullable()
    .optional()
    .describe('Tag base si no se pasa productId. Las sugerencias serán de los otros tags.'),
  limit: z.number().int().positive().max(15).default(6),
});
type GetComplementarySuggestionsInput = z.infer<typeof getComplementarySuggestionsSchema>;

export const getComplementarySuggestionsTool = new DynamicStructuredTool<
  typeof getComplementarySuggestionsSchema,
  GetComplementarySuggestionsInput
>({
  name: 'get_complementary_suggestions',
  description:
    'Devuelve productos que complementan a un plato dado: si el cliente pidió un MAIN, sugiere STARTER/SIDE/DRINK/DESSERT, etc. Útil para "¿qué le va bien a X?". Acepta productId (preferido) o categoryTag base.',
  schema: getComplementarySuggestionsSchema,
  func: async (
    { productId, categoryTag, limit }: GetComplementarySuggestionsInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { businessId } = getReactContext(config);
    let baseTag: (typeof MENU_SUGGESTION_ORDER)[number] | null = null;
    let excludeProductId: string | null = null;

    if (productId) {
      const tag = await getMenuItemCategoryTag(productId, businessId);
      if (tag && MENU_SUGGESTION_ORDER.includes(tag)) {
        baseTag = tag;
      }
      excludeProductId = productId;
    }
    if (!baseTag && categoryTag) {
      baseTag = categoryTag;
    }

    const suggestionTags = baseTag
      ? MENU_SUGGESTION_ORDER.filter((t) => t !== baseTag)
      : [...MENU_SUGGESTION_ORDER];

    const items = await fetchComplementaryMenuItems({
      businessId,
      tags: suggestionTags,
      excludeProductIds: excludeProductId ? [excludeProductId] : [],
      limit: Math.max(1, Math.min(limit, 15)),
    });

    return toJson({
      baseTag,
      suggestedTags: suggestionTags,
      count: items.length,
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        category: { name: item.categoryName, tag: item.categoryTag },
      })),
    });
  },
});

// ---------------------------------------------------------------------------
// get_business_info
// ---------------------------------------------------------------------------

const getBusinessInfoSchema = z.object({});
type GetBusinessInfoInput = z.infer<typeof getBusinessInfoSchema>;

export const getBusinessInfoTool = new DynamicStructuredTool<
  typeof getBusinessInfoSchema,
  GetBusinessInfoInput
>({
  name: 'get_business_info',
  description:
    'Devuelve datos públicos del negocio para responder preguntas básicas del cliente: nombre, descripción, zona horaria, ubicación (lat/lng), moneda y teléfono de WhatsApp. NO devuelve datos administrativos, contables ni credenciales.',
  schema: getBusinessInfoSchema,
  func: async (_input: GetBusinessInfoInput, _runManager, config?: RunnableConfig) => {
    const { businessId } = getReactContext(config);
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        name: true,
        description: true,
        timezone: true,
        slug: true,
        street_address: true,
        latitude: true,
        longitude: true,
        whatsapp_phone_number: true,
        currency: {
          select: { code: true, name: true, symbol: true },
        },
      },
    });

    if (!business) {
      return toJson({ found: false });
    }

    const hasLocation =
      typeof business.latitude === 'number' && typeof business.longitude === 'number';
    const mapsUrl = buildGoogleMapsUrl({
      name: business.name,
      streetAddress: business.street_address,
      latitude: business.latitude,
      longitude: business.longitude,
    });

    return toJson({
      found: true,
      id: business.id,
      name: business.name,
      description: business.description,
      slug: business.slug,
      timezone: business.timezone,
      whatsappPhoneNumber: business.whatsapp_phone_number,
      currency: business.currency
        ? {
            code: business.currency.code,
            name: business.currency.name,
            symbol: business.currency.symbol,
          }
        : null,
      location: hasLocation
        ? {
            latitude: business.latitude,
            longitude: business.longitude,
            mapsUrl,
          }
        : mapsUrl
          ? { mapsUrl }
          : null,
    });
  },
});

// ---------------------------------------------------------------------------
// create_payment_link
// ---------------------------------------------------------------------------

const createPaymentLinkSchema = z.object({
  method: z
    .enum(['online', 'cash'])
    .default('online')
    .describe('Método de pago: "online" para Mercado Pago, "cash" para efectivo.'),
});
type CreatePaymentLinkInput = z.infer<typeof createPaymentLinkSchema>;

export const createPaymentLinkTool = new DynamicStructuredTool<
  typeof createPaymentLinkSchema,
  CreatePaymentLinkInput
>({
  name: 'create_payment_link',
  description:
    'Genera (o reusa) un link de pago online (Mercado Pago) para el carrito activo del cliente cuando el cliente elige pagar online en texto libre. Devuelve init_point para incluir en el mensaje al cliente. Usar solo cuando el cliente ya eligió pagar online.',
  schema: createPaymentLinkSchema,
  func: async ({ method }: CreatePaymentLinkInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone } = getReactContext(config);

    if (method === 'cash') {
      return toJson({
        method: 'cash',
        message: 'El cliente eligió pagar en efectivo. Confirmale que pagará al recibir el pedido.',
      });
    }

    const result = await createOnlinePaymentLink(businessId, customerPhone);

    if (!result) {
      return toJson({
        error: 'no_payment_provider_or_empty_cart',
        message: 'No se pudo generar el link de pago. Es posible que el carrito esté vacío o el negocio no tenga Mercado Pago configurado.',
      });
    }

    return toJson({
      method: 'online',
      initPoint: result.initPoint,
      isNew: result.isNew,
      paymentIntentId: result.paymentIntentId,
    });
  },
});

// ---------------------------------------------------------------------------
// add_cart_item
// ---------------------------------------------------------------------------

const addCartItemSchema = z.object({
  productId: z
    .string()
    .uuid()
    .describe('UUID del menu_item a agregar (usar el id devuelto por search_products o find_products_by_filter)'),
  quantity: z
    .number()
    .int()
    .positive()
    .max(99)
    .default(1)
    .describe('Cantidad a agregar. Por defecto 1.'),
});
type AddCartItemInput = z.infer<typeof addCartItemSchema>;

export const addCartItemTool = new DynamicStructuredTool<
  typeof addCartItemSchema,
  AddCartItemInput
>({
  name: 'add_cart_item',
  description:
    'Agrega (o aumenta) un producto al carrito activo del cliente. ' +
    'Usá este tool cuando el cliente confirme que quiere agregar un plato en texto libre: ' +
    '"sí, agregalo", "quiero uno de eso", "ponelo", "dale", "sumá 2 pizzas", etc. ' +
    'Si el producto ya está en el carrito, suma la cantidad indicada. ' +
    'Antes de llamar necesitás el productId: si ya lo tenés del contexto úsalo; ' +
    'si no, llamá search_products primero. ' +
    'Devuelve el estado actualizado del carrito para que puedas confirmarle al cliente.',
  schema: addCartItemSchema,
  func: async ({ productId, quantity }: AddCartItemInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone } = getReactContext(config);
    const qty = Math.min(99, Math.max(1, Math.floor(quantity)));

    // Obtener o crear draft
    let draft = await prisma.draft_order.findFirst({
      where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
    });
    if (!draft) {
      const business = await prisma.business.findUnique({
        where: { id: businessId },
        select: { currency_code: true },
      });
      draft = await prisma.draft_order.create({
        data: {
          business_id: businessId,
          customer_phone: customerPhone,
          status: 'active',
          currency: business?.currency_code ?? 'ARS',
        },
      });
    }

    // Verificar que el producto existe y está disponible
    const item = await prisma.menu_item.findFirst({
      where: { id: productId, business_id: businessId, is_available: true },
      include: {
        menu_item_price: {
          where: {
            is_active: true,
            valid_from: { lte: new Date() },
            OR: [{ valid_to: null }, { valid_to: { gte: new Date() } }],
          },
          orderBy: { valid_from: 'desc' },
          take: 1,
        },
      },
    });

    if (!item) {
      return toJson({ success: false, error: 'product_not_found_or_unavailable' });
    }

    const resolved = resolveEffectivePrice(item);
    const unitPrice = resolved.finalPrice;

    const existing = await prisma.draft_order_item.findFirst({
      where: { draft_order_id: draft.id, product_id: productId },
    });

    let newQty: number;
    if (existing) {
      newQty = existing.quantity + qty;
      await prisma.draft_order_item.update({
        where: { id: existing.id },
        data: {
          quantity: newQty,
          unit_price: unitPrice,
          total_price: unitPrice.mul(newQty),
          list_price: resolved.hasDiscount ? resolved.listPrice : null,
          discount_amount: resolved.hasDiscount ? resolved.discountAmount : null,
        },
      });
    } else {
      newQty = qty;
      await prisma.draft_order_item.create({
        data: {
          draft_order_id: draft.id,
          product_id: productId,
          quantity: newQty,
          unit_price: unitPrice,
          total_price: unitPrice.mul(newQty),
          list_price: resolved.hasDiscount ? resolved.listPrice : null,
          discount_amount: resolved.hasDiscount ? resolved.discountAmount : null,
        },
      });
    }

    // Recalcular total del draft
    const agg = await prisma.draft_order_item.aggregate({
      where: { draft_order_id: draft.id },
      _sum: { total_price: true },
    });
    const newTotal = agg._sum.total_price ?? new Prisma.Decimal(0);
    await prisma.draft_order.update({
      where: { id: draft.id },
      data: { total_amount: newTotal },
    });

    await refreshDraftOrderTimeout(draft.id);

    // Devolver snapshot del carrito actualizado
    const updatedItems = await prisma.draft_order_item.findMany({
      where: { draft_order_id: draft.id },
      include: { menu_item: { select: { id: true, name: true } } },
      orderBy: { id: 'asc' },
    });

    return toJson({
      success: true,
      added: {
        itemName: item.name,
        quantity: qty,
        unitPrice: unitPrice.toString(),
        ...(resolved.hasDiscount && {
          listPrice: resolved.listPrice.toString(),
          discountAmount: resolved.discountAmount.toString(),
        }),
      },
      cart: {
        total: newTotal.toString(),
        itemCount: updatedItems.length,
        items: updatedItems.map((it) => ({
          productId: it.product_id,
          name: it.menu_item?.name ?? null,
          quantity: it.quantity,
          notes: it.notes ?? null,
        })),
      },
    });
  },
});

// ---------------------------------------------------------------------------
// remove_cart_item
// ---------------------------------------------------------------------------

const removeCartItemSchema = z.object({
  productId: z
    .string()
    .uuid()
    .describe('UUID del menu_item a remover del carrito (usar productId de get_cart)'),
});
type RemoveCartItemInput = z.infer<typeof removeCartItemSchema>;

export const removeCartItemTool = new DynamicStructuredTool<
  typeof removeCartItemSchema,
  RemoveCartItemInput
>({
  name: 'remove_cart_item',
  description:
    'Elimina completamente un producto del carrito activo del cliente. ' +
    'Usá este tool cuando el cliente pida quitar un ítem en texto libre: ' +
    '"quitá el pollo", "sacá la ensalada", "no quiero la pizza", "borralo", etc. ' +
    'Antes de llamar necesitás el productId: si no lo tenés, llamá get_cart primero. ' +
    'Si querés solo reducir la cantidad (no eliminar), usá add_cart_item con quantity negativo no es posible — ' +
    'en ese caso confirmale al cliente que el ítem fue eliminado y que puede volver a agregarlo con la cantidad deseada. ' +
    'Devuelve el estado actualizado del carrito.',
  schema: removeCartItemSchema,
  func: async ({ productId }: RemoveCartItemInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone } = getReactContext(config);

    const draft = await prisma.draft_order.findFirst({
      where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
    });

    if (!draft) {
      return toJson({ success: false, error: 'no_active_cart' });
    }

    const line = await prisma.draft_order_item.findFirst({
      where: { draft_order_id: draft.id, product_id: productId },
      include: { menu_item: { select: { id: true, name: true } } },
    });

    if (!line) {
      return toJson({ success: false, error: 'item_not_in_cart' });
    }

    const removedName = line.menu_item?.name ?? 'Producto';
    const removedQty = line.quantity;

    await prisma.draft_order_item.delete({ where: { id: line.id } });

    // Recalcular total
    const agg = await prisma.draft_order_item.aggregate({
      where: { draft_order_id: draft.id },
      _sum: { total_price: true },
    });
    const newTotal = agg._sum.total_price ?? new Prisma.Decimal(0);
    await prisma.draft_order.update({
      where: { id: draft.id },
      data: { total_amount: newTotal },
    });

    await refreshDraftOrderTimeout(draft.id);

    // Snapshot actualizado
    const updatedItems = await prisma.draft_order_item.findMany({
      where: { draft_order_id: draft.id },
      include: { menu_item: { select: { id: true, name: true } } },
      orderBy: { id: 'asc' },
    });

    return toJson({
      success: true,
      removed: { itemName: removedName, quantity: removedQty },
      cart: {
        total: newTotal.toString(),
        itemCount: updatedItems.length,
        items: updatedItems.map((it) => ({
          productId: it.product_id,
          name: it.menu_item?.name ?? null,
          quantity: it.quantity,
          notes: it.notes ?? null,
        })),
      },
    });
  },
});

// ---------------------------------------------------------------------------
// update_item_note
// ---------------------------------------------------------------------------

const updateItemNoteSchema = z.object({
  productId: z
    .string()
    .uuid()
    .describe('UUID del menu_item al que pertenece la nota (usar productId devuelto por get_cart o search_products)'),
  note: z
    .string()
    .max(300)
    .describe('Instrucción especial del cliente para ese platillo. Ej: "término medio", "sin cebolla", "poca sal". Enviar cadena vacía para borrar la nota.'),
});
type UpdateItemNoteInput = z.infer<typeof updateItemNoteSchema>;

export const updateItemNoteTool = new DynamicStructuredTool<
  typeof updateItemNoteSchema,
  UpdateItemNoteInput
>({
  name: 'update_item_note',
  description:
    'Guarda (o reemplaza) la nota/instrucción especial de un ítem del carrito activo. ' +
    'Usá este tool cuando el cliente indique preferencias de preparación para un platillo ' +
    '(ej: término de cocción, ingredientes a omitir, cantidad de sal, etc.). ' +
    'Antes de llamar a este tool asegurate de tener el productId del ítem: usá get_cart si no lo tenés. ' +
    'Devuelve el nombre del ítem y la nota guardada para que puedas confirmarle al cliente.',
  schema: updateItemNoteSchema,
  func: async ({ productId, note }: UpdateItemNoteInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone } = getReactContext(config);

    const draft = await prisma.draft_order.findFirst({
      where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
      include: {
        draft_order_item: {
          include: { menu_item: { select: { id: true, name: true } } },
        },
      },
    });

    if (!draft) {
      return toJson({ success: false, error: 'no_active_cart' });
    }

    const line = draft.draft_order_item.find((it) => it.product_id === productId);

    if (!line) {
      return toJson({
        success: false,
        error: 'item_not_in_cart',
        hint: 'El producto no está en el carrito activo. Verificá el productId con get_cart.',
      });
    }

    const normalizedNote = note.trim() || null;

    await prisma.draft_order_item.update({
      where: { id: line.id },
      data: { notes: normalizedNote },
    });

    return toJson({
      success: true,
      itemName: line.menu_item?.name ?? 'Producto',
      note: normalizedNote,
    });
  },
});

export const allReactTools = [
  searchProductsTool,
  getProductsDetailsByIdsTool,
  getFeaturedProductsTool,
  getCategoriesTool,
  getMenuByCategoryTool,
  getCartTool,
  getBusinessHoursTool,
  getRecentMessagesTool,
  findProductsByFilterTool,
  checkProductAvailabilityTool,
  getComplementarySuggestionsTool,
  getBusinessInfoTool,
  createPaymentLinkTool,
  addCartItemTool,
  removeCartItemTool,
  updateItemNoteTool,
];
