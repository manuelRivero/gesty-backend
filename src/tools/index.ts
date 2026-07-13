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
import { findRecentMessagesForDetectionContext, findDefaultCustomerAddress } from '../repositories';
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
import { partySizeMetadataFields, normalizeMetadata } from '../services/productQuery/utils';
import { resolveDeliveryContext } from '../services/deliveryFee.service';
import { patchConversationMetadata, omitConversationMetadataKeys } from '../repositories/conversationState.repository';
import { clearLastOffer } from '../services/lastOffer.service';
import {
  getOrderCompletionLedger,
  recordOrderCompletionAbandonment,
  reviveOrderCompletionIfAbandoned,
} from '../services/orderCompletionGoal.service';
import {
  getReservationCompletionLedger,
  recordReservationCompletionAbandonment,
} from '../services/reservationCompletionGoal.service';
import { updateCustomerName } from '../repositories';
import { AddressService } from '../services/address.service';

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
      items: shortlisted.map((item) =>
        toShortlistItem({
          ...item,
          // La raw SQL devuelve campos planos; los reempaquetamos al formato
          // que espera toShortlistItem para que category.name llegue al agente
          menu_category: item.category_id
            ? { id: item.category_id, name: item.category_name ?? '', category_tag: item.category_tag ?? null }
            : null,
        })
      ),
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
    'Incluye precios con descuento por producto, el costo real de envío YA aplicado al total del pedido ' +
    '(pricing.deliveryFee, solo si hay dirección guardada en cobertura) y los ajustes reales por ' +
    'método de pago (paymentOptions: descuento efectivo / recargo online, si el negocio los tiene configurados). ' +
    'Para responder si el negocio hace delivery a la zona del cliente o cuánto cuesta el envío en general ' +
    '(sin depender de que haya carrito), usá check_delivery_coverage en vez de esta tool.',
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

    // Ajustes reales por método de pago (no incluyen el costo de envío).
    const paymentAdjustments = await listPaymentAdjustmentsForAmount({
      businessId,
      baseAmount: itemsTotal,
    });

    // Costo real de envío: se resuelve por dirección/zona, no por si el
    // cliente ya tocó el botón de "delivery". `resolveDeliveryContext` exige
    // fulfillmentType==='DELIVERY' para no devolver de más en un pedido de
    // TAKE_AWAY confirmado — pero antes de elegir tipo de entrega (fulfillment_type
    // aún null) la pregunta "¿cuánto sale el envío?" es legítima y respondible
    // si el cliente ya tiene una dirección default en cobertura de una compra
    // anterior. Sin este `?? 'DELIVERY'`, la respuesta decía "necesito tu
    // dirección" aunque el sistema ya la tuviera, solo porque todavía no se
    // había tocado el botón de delivery (bug real, encontrado en prueba manual).
    const deliveryLookupType = draft.fulfillment_type === 'TAKE_AWAY' ? null : 'DELIVERY';
    const deliveryCtx = await resolveDeliveryContext({
      customerId,
      businessId,
      fulfillmentType: deliveryLookupType,
    });
    const deliveryFeeKnown = deliveryLookupType === 'DELIVERY' && deliveryCtx.zoneId !== null;

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
        deliveryFee: deliveryFeeKnown ? deliveryCtx.deliveryFee.toFixed(2) : null,
        total: deliveryFeeKnown ? (itemsTotal + deliveryCtx.deliveryFee).toFixed(2) : null,
        note:
          deliveryLookupType === 'DELIVERY' && !deliveryFeeKnown
            ? 'El costo de envío depende de la zona — todavía no hay una dirección guardada en cobertura. ' +
              'Si el cliente pregunta cuánto sale, invitalo a compartir la dirección para darle el número exacto.'
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
    const { businessId, customerPhone, conversationId } = getReactContext(config);
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
      // Inicialización (no renovación): fija el primer expires_at del draft
      // recién creado. La renovación por actividad del usuario la maneja
      // exclusivamente touchSession (src/services/sessionActivity.service.ts).
      await refreshDraftOrderTimeout(draft.id);
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
    // Si el draft ya existía, touchSession ya renovó su expires_at al
    // inicio del turno; si acaba de crearse, ya se inicializó más arriba.

    if (conversationId) {
      await clearLastOffer(conversationId);
      // Revival del Goal COMPLETAR_PEDIDO (ADR-0005, corolario): si el
      // cliente había abandonado el pedido y agrega otro ítem, el abandono
      // se limpia solo.
      const stateForRevival = await prisma.conversation_state.findUnique({
        where: { conversation_id: conversationId },
        select: { metadata: true },
      });
      await reviveOrderCompletionIfAbandoned(
        conversationId,
        getOrderCompletionLedger(stateForRevival?.metadata)
      );
    }

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

// ADR-0002: el Constraint "no eliminar sin confirmar" vive acá, en el borde
// de la Tool — no en el prompt. La evidencia de confirmación es un pending
// que se escribió en un llamado/turno anterior, nunca un flag que el modelo
// pueda setear en el mismo schema (eso sería confiar en el llamador).
//
// `pendingAction`/`pendingItemId` es la MISMA clave que usa el flujo
// determinístico de botones (`cart.service.ts`, `RemoveItemHandler`) para su
// propia confirmación por UI. Antes esta Tool llevaba su propio
// `pending_item_removal` separado — dos fuentes de verdad para "¿ya se
// preguntó por este ítem?" que no se enteraban una de la otra. Un cliente que
// respondía en texto libre ("sí") a la confirmación por botones podía terminar
// re-preguntado por la Tool, y viceversa. Unificar en un solo campo hace que
// cualquiera de los dos caminos que preguntó primero sea evidencia válida
// para que el otro proceda — ya no hay dos preguntas por el mismo ítem.
const REMOVAL_CONFIRMATION_TTL_MS = 5 * 60 * 1000;

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
    'Requiere confirmación explícita del cliente: el primer llamado NO elimina — devuelve ' +
    '`requiresConfirmation: true` con el ítem encontrado. Preguntale al cliente si confirma ' +
    '("¿confirmás que elimino la milanesa?") y llamá la tool de nuevo con el mismo productId ' +
    'recién cuando el cliente confirme explícitamente. No la llames dos veces en el mismo turno ' +
    'sin que el cliente haya confirmado entre medio. ' +
    'Si querés solo reducir la cantidad (no eliminar), usá add_cart_item con quantity negativo no es posible — ' +
    'en ese caso confirmale al cliente que el ítem fue eliminado y que puede volver a agregarlo con la cantidad deseada. ' +
    'Devuelve el estado actualizado del carrito.',
  schema: removeCartItemSchema,
  func: async ({ productId }: RemoveCartItemInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone, conversationId } = getReactContext(config);

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

    const stateRow = await prisma.conversation_state.findUnique({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const metadata = normalizeMetadata(stateRow?.metadata);
    const isConfirmed =
      metadata.pendingAction === 'CONFIRM_REMOVE' &&
      metadata.pendingItemId === productId &&
      typeof metadata.pendingActionAt === 'string' &&
      Date.now() - new Date(metadata.pendingActionAt).getTime() <= REMOVAL_CONFIRMATION_TTL_MS;

    if (!isConfirmed) {
      await patchConversationMetadata(conversationId, {
        pendingAction: 'CONFIRM_REMOVE',
        pendingItemId: productId,
        pendingItemName: removedName,
        pendingActionAt: new Date().toISOString(),
      });
      return toJson({
        success: false,
        requiresConfirmation: true,
        item: { productId, itemName: removedName, quantity: removedQty },
        message:
          'Pedile confirmación explícita al cliente antes de eliminar. Volvé a llamar esta tool ' +
          'con el mismo productId solo si el cliente confirma.',
      });
    }

    await omitConversationMetadataKeys(conversationId, [
      'pendingAction',
      'pendingItemId',
      'pendingItemName',
      'pendingActionAt',
    ]);
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
    // Remover un ítem nunca crea un draft: touchSession ya renovó su
    // expires_at al inicio del turno.

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

// ---------------------------------------------------------------------------
// save_party_size
// ---------------------------------------------------------------------------

const savePartySizeSchema = z.object({
  count: z
    .number()
    .int()
    .min(1)
    .max(99)
    .describe('Número de personas que van a comer (1–99).'),
});
type SavePartySizeInput = z.infer<typeof savePartySizeSchema>;

export const savePartySizeTool = new DynamicStructuredTool<
  typeof savePartySizeSchema,
  SavePartySizeInput
>({
  name: 'save_party_size',
  description:
    'Guarda el número de personas para el pedido actual. ' +
    'Llamá este tool cuando el cliente indique cuántas personas van a comer, en cualquier forma: ' +
    '"somos 4", "para mí y mi pareja" (→ 2), "para tres personas", "éramos 6", etc. ' +
    'Interpretá el número vos antes de llamar el tool. ' +
    'Una vez guardado, el sistema usa el dato para sugerir cantidades adecuadas.',
  schema: savePartySizeSchema,
  func: async ({ count }: SavePartySizeInput, _runManager, config?: RunnableConfig) => {
    const { conversationId } = getReactContext(config);
    await patchConversationMetadata(conversationId, {
      ...partySizeMetadataFields(count),
      awaitingPeopleCount: false,
      awaitingPartySize: false,
    });
    await omitConversationMetadataKeys(conversationId, ['peopleCountResume']);
    return toJson({ success: true, partySize: count });
  },
});

// ---------------------------------------------------------------------------
// save_customer_name
// ---------------------------------------------------------------------------

const saveCustomerNameSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(100)
    .describe('Nombre o alias del cliente tal como lo dijo.'),
});
type SaveCustomerNameInput = z.infer<typeof saveCustomerNameSchema>;

export const saveCustomerNameTool = new DynamicStructuredTool<
  typeof saveCustomerNameSchema,
  SaveCustomerNameInput
>({
  name: 'save_customer_name',
  description:
    'Guarda el nombre del cliente cuando lo menciona por primera vez. ' +
    'Usalo cuando el cliente diga su nombre de forma natural: ' +
    '"soy Juan", "me llamo Ana", "Juan Pérez" como respuesta a una pregunta, etc. ' +
    'Solo llamar si el nombre del cliente aparece como "no informado" en el estado.',
  schema: saveCustomerNameSchema,
  func: async ({ name }: SaveCustomerNameInput, _runManager, config?: RunnableConfig) => {
    const { customerId } = getReactContext(config);
    await updateCustomerName(customerId, name.trim());
    return toJson({ success: true, name: name.trim() });
  },
});

// ---------------------------------------------------------------------------
// save_delivery_address
// ---------------------------------------------------------------------------

const saveDeliveryAddressSchema = z.object({
  addressText: z
    .string()
    .min(3)
    .describe('Dirección de entrega tal como la escribió el cliente (calle, número, ciudad, etc.).'),
});
type SaveDeliveryAddressInput = z.infer<typeof saveDeliveryAddressSchema>;

export const saveDeliveryAddressTool = new DynamicStructuredTool<
  typeof saveDeliveryAddressSchema,
  SaveDeliveryAddressInput
>({
  name: 'save_delivery_address',
  description:
    'Geocodifica y guarda la dirección de entrega del cliente. ' +
    'Llamá este tool cuando el cliente proporcione su dirección para delivery. ' +
    'Devuelve status: "saved" (con formattedAddress), "out_of_coverage" o "not_found". ' +
    'Si "saved": confirmale la dirección normalizada y seguí con el pedido. ' +
    'Si "out_of_coverage": informale amablemente y ofrecé retiro en local si está disponible. ' +
    'Si "not_found": pedile que reformule la dirección.',
  schema: saveDeliveryAddressSchema,
  func: async (
    { addressText }: SaveDeliveryAddressInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { businessId, customerId } = getReactContext(config);
    const result = await new AddressService().resolveAndSave({
      businessId,
      customerId,
      addressText,
    });
    return toJson(result);
  },
});

// ---------------------------------------------------------------------------
// stage_delivery_address (híbrido — pregunta de envío delegada)
// ---------------------------------------------------------------------------

const stageDeliveryAddressSchema = z.object({
  addressText: z
    .string()
    .min(3)
    .describe('Dirección que el cliente compartió, tal como la escribió (calle, número, ciudad, etc.).'),
});
type StageDeliveryAddressInput = z.infer<typeof stageDeliveryAddressSchema>;

export const stageDeliveryAddressTool = new DynamicStructuredTool<
  typeof stageDeliveryAddressSchema,
  StageDeliveryAddressInput
>({
  name: 'stage_delivery_address',
  description:
    'Geocodifica la dirección que el cliente compartió (típicamente al preguntar cuánto sale el envío) y la ' +
    'deja pendiente de confirmación — NO la guarda todavía. Devuelve status: "in_coverage" (con formattedAddress) ' +
    '| "out_of_coverage" | "not_found". Si "in_coverage": llamá present_address_confirmation() de inmediato para ' +
    'mostrar los botones de confirmar/editar. Si "out_of_coverage" o "not_found": explicá el problema en texto, ' +
    'no llames present_address_confirmation.',
  schema: stageDeliveryAddressSchema,
  func: async ({ addressText }: StageDeliveryAddressInput, _runManager, config?: RunnableConfig) => {
    const { businessId, conversationId } = getReactContext(config);
    const result = await new AddressService().stageAddressForDelegatedConfirmation({
      businessId,
      conversationId,
      text: addressText,
    });
    return toJson(result);
  },
});

// ---------------------------------------------------------------------------
// present_address_confirmation (híbrido — señal-UI para stage_delivery_address)
// ---------------------------------------------------------------------------

const presentAddressConfirmationSchema = z.object({});
type PresentAddressConfirmationInput = z.infer<typeof presentAddressConfirmationSchema>;

export const presentAddressConfirmationTool = new DynamicStructuredTool<
  typeof presentAddressConfirmationSchema,
  PresentAddressConfirmationInput
>({
  name: 'present_address_confirmation',
  description:
    'Muestra al cliente los botones para confirmar o editar la dirección staged con stage_delivery_address. ' +
    'Solo llamar después de que esa tool devolvió status "in_coverage". ' +
    'El sistema construye los botones; no describas la dirección en texto ni pidas confirmación verbal.',
  schema: presentAddressConfirmationSchema,
  func: async (_input: PresentAddressConfirmationInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'present_address_confirmation' });
  },
});

// ---------------------------------------------------------------------------
// check_delivery_coverage (híbrido — cobertura/costo, independiente del carrito)
// ---------------------------------------------------------------------------

const checkDeliveryCoverageSchema = z.object({});
type CheckDeliveryCoverageInput = z.infer<typeof checkDeliveryCoverageSchema>;

export const checkDeliveryCoverageTool = new DynamicStructuredTool<
  typeof checkDeliveryCoverageSchema,
  CheckDeliveryCoverageInput
>({
  name: 'check_delivery_coverage',
  description:
    'Devuelve la dirección GUARDADA del cliente, si el negocio hace delivery ahí y cuánto cuesta — ' +
    'sin depender de que haya un carrito activo. Usala para CUALQUIER pregunta sobre su dirección ' +
    '("¿cuál dirección tienen guardada?"), cobertura ("¿hacen delivery a mi dirección?", "¿llegan hasta ' +
    'mi zona?") o costo de envío ("¿cuánto sale el envío?"), incluso si el cliente todavía no agregó ' +
    'nada al pedido. NUNCA respondas que no tenés acceso a la dirección sin llamar esta tool primero. ' +
    'Devuelve hasAddress (false si el cliente nunca guardó una dirección — en ese caso pedísela e invocá ' +
    'stage_delivery_address con lo que responda), y si hasAddress es true: address, inCoverage, ' +
    'deliveryFee, minOrderAmount, estimatedMinutes (todos null si inCoverage es false).',
  schema: checkDeliveryCoverageSchema,
  func: async (_input: CheckDeliveryCoverageInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerId } = getReactContext(config);
    const defaultAddress = await findDefaultCustomerAddress(customerId);
    if (!defaultAddress) {
      return toJson({ hasAddress: false });
    }

    const deliveryCtx = await resolveDeliveryContext({
      customerId,
      businessId,
      fulfillmentType: 'DELIVERY',
    });
    const inCoverage = deliveryCtx.zoneId !== null;

    return toJson({
      hasAddress: true,
      address: defaultAddress.street_address,
      inCoverage,
      deliveryFee: inCoverage ? deliveryCtx.deliveryFee.toFixed(2) : null,
      minOrderAmount: inCoverage ? deliveryCtx.minOrderAmount.toFixed(2) : null,
      estimatedMinutes: inCoverage ? deliveryCtx.estimatedMinutes : null,
    });
  },
});

// ---------------------------------------------------------------------------
// present_cart (señal-UI)
// ---------------------------------------------------------------------------

const presentCartSchema = z.object({});
type PresentCartInput = z.infer<typeof presentCartSchema>;

export const presentCartTool = new DynamicStructuredTool<
  typeof presentCartSchema,
  PresentCartInput
>({
  name: 'present_cart',
  description:
    'Muestra el resumen interactivo del carrito actual con opciones para modificar, seguir comprando, finalizar o cancelar. ' +
    'Llamá esta tool después de add_cart_item (en lugar de escribir un resumen en texto libre) ' +
    'y también cuando el cliente quiera ver qué tiene en el pedido. ' +
    'No describas el carrito en texto: esta tool construye el mensaje interactivo completo.',
  schema: presentCartSchema,
  func: async (_input: PresentCartInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'present_cart' });
  },
});

// ---------------------------------------------------------------------------
// present_welcome_options (señal-UI — empuje proactivo en el primer saludo)
// ---------------------------------------------------------------------------

const presentWelcomeOptionsSchema = z.object({
  bodyText: z
    .string()
    .min(1)
    .describe(
      'Tu saludo breve y propio (1-2 oraciones), ofreciendo concretamente ver el menú, hacer un ' +
        'pedido o reservar una mesa — NO una pregunta abierta genérica tipo "¿en qué te ayudo?".'
    ),
});
type PresentWelcomeOptionsInput = z.infer<typeof presentWelcomeOptionsSchema>;

export const presentWelcomeOptionsTool = new DynamicStructuredTool<
  typeof presentWelcomeOptionsSchema,
  PresentWelcomeOptionsInput
>({
  name: 'present_welcome_options',
  description:
    'Muestra tu saludo junto a botones concretos (ver menú, reservar mesa, etc.) en el primer saludo ' +
    'de la conversación. Llamala en vez de responder solo texto cuando el cliente saluda sin pedir algo ' +
    'específico — el objetivo es empujarlo activamente hacia armar un pedido o reservar, no solo ' +
    'preguntar "¿en qué te ayudo?" y esperar.',
  schema: presentWelcomeOptionsSchema,
  func: async ({ bodyText }: PresentWelcomeOptionsInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'present_welcome_options', bodyText });
  },
});

// ---------------------------------------------------------------------------
// abandon_pending_order (Ledger — Tool de la familia Intent, ADR-0005/0007/0008)
// ---------------------------------------------------------------------------

const abandonPendingOrderSchema = z.object({});
type AbandonPendingOrderInput = z.infer<typeof abandonPendingOrderSchema>;

export const abandonPendingOrderTool = new DynamicStructuredTool<
  typeof abandonPendingOrderSchema,
  AbandonPendingOrderInput
>({
  name: 'abandon_pending_order',
  description:
    'Registrá que el cliente pidió explícitamente que dejes de insistir con el pedido pendiente ' +
    '("dejalo", "no me sigas preguntando por el pedido", "olvidate de eso", "no quiero seguir con eso"). ' +
    'NO borra el carrito ni sus ítems — el pedido sigue ahí por si el cliente vuelve más tarde. ' +
    'Solo silencia los recordatorios del sistema sobre ese pedido. Si el cliente agrega otro ítem ' +
    'después, el silencio se levanta solo.',
  schema: abandonPendingOrderSchema,
  func: async (_input: AbandonPendingOrderInput, _runManager, config?: RunnableConfig) => {
    const { conversationId } = getReactContext(config);
    const stateRow = await prisma.conversation_state.findUnique({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const ledger = getOrderCompletionLedger(stateRow?.metadata);
    await recordOrderCompletionAbandonment(conversationId, ledger);
    return toJson({ success: true, message: 'Listo, no insisto más con el pedido pendiente.' });
  },
});

// ---------------------------------------------------------------------------
// abandon_pending_reservation (Ledger — Tool de la familia Intent, Fase 1b)
// ---------------------------------------------------------------------------

const abandonPendingReservationSchema = z.object({});
type AbandonPendingReservationInput = z.infer<typeof abandonPendingReservationSchema>;

export const abandonPendingReservationTool = new DynamicStructuredTool<
  typeof abandonPendingReservationSchema,
  AbandonPendingReservationInput
>({
  name: 'abandon_pending_reservation',
  description:
    'Registrá que el cliente pidió explícitamente que dejes de insistir con la reserva pendiente ' +
    '("dejalo", "no me sigas preguntando por la reserva", "olvidate de la reserva por ahora"). ' +
    'NO borra el borrador — la reserva sigue ahí por si el cliente la retoma más tarde. ' +
    'Solo silencia los recordatorios del sistema sobre esa reserva.',
  schema: abandonPendingReservationSchema,
  func: async (_input: AbandonPendingReservationInput, _runManager, config?: RunnableConfig) => {
    const { conversationId } = getReactContext(config);
    const stateRow = await prisma.conversation_state.findUnique({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const ledger = getReservationCompletionLedger(stateRow?.metadata);
    await recordReservationCompletionAbandonment(conversationId, ledger);
    return toJson({ success: true, message: 'Listo, no insisto más con la reserva pendiente.' });
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
  addCartItemTool,
  removeCartItemTool,
  updateItemNoteTool,
  savePartySizeTool,
  presentCartTool,
  presentWelcomeOptionsTool,
  abandonPendingOrderTool,
  abandonPendingReservationTool,
  stageDeliveryAddressTool,
  presentAddressConfirmationTool,
  checkDeliveryCoverageTool,
];
