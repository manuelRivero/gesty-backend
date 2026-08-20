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
import { Prisma, OrderStatus } from '@prisma/client';
import { MenuService } from '../services/menu.service';
import { getBusinessOpenInfo } from '../services/businessHours.service';
import {
  findRecentMessagesForDetectionContext,
  findDefaultCustomerAddress,
  findOrCreateConversationState,
} from '../repositories';
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
import {
  partySizeMetadataFields,
  normalizeMetadata,
  getRequestedPartySize,
  PENDING_PRODUCT_SELECTION_KEYS,
} from '../services/productQuery/utils';
import { resolveDeliveryContext } from '../services/deliveryFee.service';
import { patchConversationMetadata, omitConversationMetadataKeys } from '../repositories/conversationState.repository';
import { clearLastOffer } from '../services/lastOffer.service';
import {
  markComplementEngagedIfOffered,
  markComplementRefused,
  resolvePostAddComplementOpportunity,
  type PostAddComplementOpportunity,
} from '../services/intent/opportunities.service';
import {
  setPendingVariation,
  clearPendingVariation,
} from '../services/pendingVariation.service';
import {
  buildPendingAddQuantityMessage,
  clearPendingAddQuantity,
  getPendingAddQuantity,
  isPendingAddQuantityReply,
  setPendingAddQuantity,
} from '../services/pendingAddQuantity.service';
import {
  buildPendingItemNoteMessage,
  clearPendingItemNote,
  setPendingItemNote,
} from '../services/pendingItemNote.service';
import {
  activateNextOrderLine,
  advanceAfterLineClose,
  buildOrderLinesContinueOrCancelHint,
  cancelOrderLine,
  clearPendingOrderLines,
  getActiveOrderLine,
  getPendingOrderLines,
  hasOpenOrderLines,
  ORDER_LINES_MAX,
  resolveOrderLineForProduct,
  setPendingOrderLines,
  type OrderLine,
} from '../services/pendingOrderLines.service';
import {
  isConfirmedAddQuantity,
  needsAddQuantityConfirmation,
  suggestAddQuantity,
} from '../services/addQuantitySuggestion';
import {
  getOrderCompletionLedger,
  recordOrderCompletionAbandonment,
  reviveOrderCompletionIfAbandoned,
} from '../services/orderCompletionGoal.service';
import {
  getPartySizeGoalLedger,
  derivePartySizeGoal,
  PARTY_SIZE_GOAL_TYPE,
} from '../services/partySizeGoal.service';
import { getIntentCatalogEntry } from '../domain/intent/family';
import {
  getReservationCompletionLedger,
  recordReservationCompletionAbandonment,
} from '../services/reservationCompletionGoal.service';
import { updateCustomerName } from '../repositories';
import { AddressService } from '../services/address.service';
import { shortOrderRef } from '../services/orderStatusNotification.service';
import {
  ORDER_STATUS_LABEL_ES,
  ORDER_PAYMENT_STATUS_LABEL_ES,
} from '../constants/orderWorkflow';
import { hasVariations, matchVariation } from '../services/menu/menuItemVariations';
import { SUPPORT_MESSAGE, handOverToHuman } from '../services/humanHandover.service';

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
  variations?: string[] | null;
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
    // Se omite la clave cuando no hay variaciones para no gastar tokens con
    // "variations": [] en cada producto del catálogo (D1, Fase 5 Tarea 5.1).
    ...(item.variations?.length ? { variations: item.variations } : {}),
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
  description:
    'Devuelve las categorías de menú visibles (id, title). Usala para matchear cuando el cliente ' +
    'escribe el nombre de una categoría en texto libre (ej. "bebidas frías", "postres") antes de ' +
    'llamar present_category.',
  schema: getCategoriesSchema,
  func: async (_input: GetCategoriesInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerId } = getReactContext(config);
    const res = await MenuService.getCategoryListForCustomer({ businessId, customerId });
    return toJson({
      text: res.text,
      categories: res.buttons.map((b) => {
        const id =
          typeof b.payload === 'string' && b.payload.startsWith('CATEGORY:')
            ? b.payload.slice('CATEGORY:'.length)
            : null;
        return { id, title: b.title, payload: b.payload };
      }),
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

    // Ajustes reales por método de pago ofrecido ahora (filtra cash si hay
    // delivery externo, y online sin Mercado Pago activo).
    const { getBusinessConfig } = await import('../services/businessConfig.service');
    const { listOfferedPaymentMethods } = await import('../services/paymentMethods.service');
    const bizCfg = await getBusinessConfig(businessId);
    const offeredMethods = await listOfferedPaymentMethods(businessId, {
      externalDeliveryEnabled: bizCfg.external_delivery_enabled,
    });
    const offeredIds = new Set(offeredMethods.map((m) => m.id));
    const paymentAdjustments = (
      await listPaymentAdjustmentsForAmount({
        businessId,
        baseAmount: itemsTotal,
      })
    ).filter((a) => offeredIds.has(a.paymentMethod as typeof offeredMethods[number]['id']));

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
        // La variación es parte de la identidad de la línea (D4): sin esto el
        // agente describe dos "Pizza" idénticas en vez de Especial/Roquefort.
        variation: it.variation ?? null,
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
// get_payment_methods
// ---------------------------------------------------------------------------

const getPaymentMethodsSchema = z.object({});
type GetPaymentMethodsInput = z.infer<typeof getPaymentMethodsSchema>;

export const getPaymentMethodsTool = new DynamicStructuredTool<
  typeof getPaymentMethodsSchema,
  GetPaymentMethodsInput
>({
  name: 'get_payment_methods',
  description:
    'Devuelve las formas de pago que ofrece el negocio y los ajustes configurados (descuento/recargo), ' +
    'SIN depender de que haya un carrito activo. Usala para "¿aceptan transferencia?", "¿qué formas de pago tienen?", ' +
    '"¿hay descuento por efectivo?" y preguntas similares aunque el cliente todavía no haya armado un pedido. ' +
    'Si hay carrito activo, los ajustes vienen con el monto real calculado sobre el total; si no, vienen como regla ' +
    '(tipo y valor) sin monto final.',
  schema: getPaymentMethodsSchema,
  func: async (_input: GetPaymentMethodsInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone } = getReactContext(config);
    const { getBusinessConfig } = await import('../services/businessConfig.service');
    const { listOfferedPaymentMethods } = await import('../services/paymentMethods.service');

    const bizCfg = await getBusinessConfig(businessId);
    const offeredMethods = await listOfferedPaymentMethods(businessId, {
      externalDeliveryEnabled: bizCfg.external_delivery_enabled,
    });
    const offeredIds = new Set(offeredMethods.map((m) => m.id));
    const methods = offeredMethods.map((m) => ({ id: m.id, label: m.label }));

    const draft = await prisma.draft_order.findFirst({
      where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
      include: { draft_order_item: true },
    });

    if (draft && draft.draft_order_item.length > 0) {
      const pricing = computeOrderPricing(draft.draft_order_item);
      const itemsTotal = pricing.subtotal - pricing.productDiscounts;
      const adjustments = (
        await listPaymentAdjustmentsForAmount({ businessId, baseAmount: itemsTotal })
      ).filter((a) => offeredIds.has(a.paymentMethod as typeof offeredMethods[number]['id']));

      return toJson({
        methods,
        adjustments: adjustments.map((a) => ({
          method: a.paymentMethod,
          label: a.label,
          adjustment: a.adjustmentAmount.toFixed(2),
          finalAmount: a.finalAmount.toFixed(2),
          isSurcharge: a.isSurcharge,
        })),
        note: null,
      });
    }

    // Sin carrito activo no hay un total sobre el cual calcular el monto: se
    // devuelve la regla configurada (D4), no un número inventado.
    const configs = await prisma.payment_method_config.findMany({
      where: { business_id: businessId, is_active: true },
    });
    const adjustments = configs
      .filter(
        (c) => offeredIds.has(c.payment_method as typeof offeredMethods[number]['id']) &&
          Number(c.adjustment_value) > 0
      )
      .map((c) => ({
        method: c.payment_method,
        label: c.label,
        type: c.adjustment_type,
        value: Number(c.adjustment_value),
        isSurcharge: c.is_surcharge,
      }));

    return toJson({
      methods,
      adjustments,
      note:
        adjustments.length > 0
          ? 'El monto final se calcula sobre el total del pedido al cerrarlo — todavía no hay carrito activo.'
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
        ...(item.variations?.length ? { variations: item.variations } : {}),
      })),
    });
  },
});

// ---------------------------------------------------------------------------
// get_popular_products
// ---------------------------------------------------------------------------

const getPopularProductsSchema = z.object({
  currencyCode: z.string().nullable().optional(),
  limit: z.number().int().positive().max(20).default(5),
});
type GetPopularProductsInput = z.infer<typeof getPopularProductsSchema>;

export const getPopularProductsTool = new DynamicStructuredTool<
  typeof getPopularProductsSchema,
  GetPopularProductsInput
>({
  name: 'get_popular_products',
  description:
    'Devuelve los productos más pedidos en base a ventas reales de los últimos 30 días. ' +
    'Usala para "¿qué es lo más pedido?", "¿qué pide más la gente?", "¿cuál es el más popular?" y "¿qué me recomendás?". ' +
    'Si "significant" es false, no hay suficientes datos todavía — NO inventes un ranking ni digas que algo es lo más pedido.',
  schema: getPopularProductsSchema,
  func: async (
    { currencyCode, limit }: GetPopularProductsInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { businessId } = getReactContext(config);
    const { getPopularMenuItems } = await import('../services/popularProducts.service');
    const { significant, items } = await getPopularMenuItems({
      businessId,
      currencyCode: currencyCode ?? null,
      limit,
    });
    return toJson({
      significant,
      count: items.length,
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        orderCount: item.orderCount,
        prices: item.prices,
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
          variations: true,
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
        variations: true,
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
        ...(item.variations.length ? { variations: item.variations } : {}),
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
    .optional()
    .describe(
      'Unidades a agregar, solo si el cliente las dijo en ESTE mensaje ' +
        '("dos milanesas", "solo una"). NO uses el party size ni "para N personas". ' +
        'Si no dijo unidades, omití el campo: el sistema sugerirá y pedirá confirmación.'
    ),
  variation: z
    .string()
    .optional()
    .describe(
      'Variedad elegida por el cliente (ej. "Roquefort") cuando el producto tiene variaciones ' +
      '(ver el campo variations devuelto por search_products/find_products_by_filter/get_products_details_by_ids). ' +
      'Obligatorio si el producto tiene variaciones: si no la tenés, preguntale al cliente cuál quiere ' +
      'antes de llamar a esta tool. Tiene que ser una de las listadas en variations, nunca inventada.'
    ),
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
    'Si el producto ya está en el carrito con la misma variación, suma la cantidad indicada; ' +
    'variaciones distintas del mismo producto son líneas separadas. ' +
    'Antes de llamar necesitás el productId: si ya lo tenés del contexto úsalo; ' +
    'si no, llamá search_products primero. Si el producto tiene variaciones y no sabés cuál quiere ' +
    'el cliente, preguntale antes de llamar (esta tool rechaza el llamado si falta y el producto la requiere). ' +
    'Devuelve el carrito actualizado. Si incluye "opportunity" con nextAction ' +
    'present_complement_suggestions, llamá esa tool en este turno (no preguntes upsell en prosa).',
  schema: addCartItemSchema,
  func: async (
    { productId, quantity, variation }: AddCartItemInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { businessId, customerPhone, conversationId, turnStartedAt } =
      getReactContext(config);

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

    let partySize: number | null = null;
    let pendingReply = false;
    let partySizeGoalBlocksAdd = false;
    let orderLine: OrderLine | null = null;
    if (conversationId) {
      const state = await findOrCreateConversationState(conversationId);
      const meta = normalizeMetadata(state.metadata);
      partySize = getRequestedPartySize(meta) ?? null;
      const pendingQty = getPendingAddQuantity(meta);
      pendingReply = isPendingAddQuantityReply({
        pending: pendingQty,
        productId,
        quantity: quantity ?? null,
        turnStartedAt,
      });
      orderLine = resolveOrderLineForProduct(getPendingOrderLines(meta), item.name);
      // Gate duro: sin Fact de personas y Goal aún con presupuesto → no escribir carrito.
      const partyLedger = getPartySizeGoalLedger(meta);
      const partyGoal = derivePartySizeGoal(
        {
          partySize,
          foodRelatedSignal: true,
          checkoutActive: meta.checkout_active === true,
        },
        partyLedger
      );
      const maxSurfaces = getIntentCatalogEntry(PARTY_SIZE_GOAL_TYPE).maxSurfaces;
      // La línea de la cola con cantidad explícita ya resuelve para qué servía
      // el Fact de personas (sugerir unidades): no tiene sentido bloquear el
      // add para preguntar algo que no vamos a usar. Las líneas SIN cantidad
      // ("una bebida") siguen bajo el Goal blocking.
      partySizeGoalBlocksAdd =
        partyGoal.open &&
        partyLedger.surfaceCount < maxSurfaces &&
        orderLine?.requestedQuantity == null;
    }

    if (partySizeGoalBlocksAdd) {
      return toJson({
        success: false,
        error: 'party_size_required',
        pending: true,
        instruction:
          'Falta cuántas personas comen (Goal OBTENER_PERSONAS_DEL_PEDIDO). ' +
          'Preguntá el número (1–99), llamá save_party_size cuando lo diga, ' +
          'y recién después reintentá add_cart_item. NO digas que ya sumaste.',
      });
    }

    const { suggestedQuantity } = suggestAddQuantity({
      partySize,
      servesPeople: item.serves_people,
    });
    // D4 — la cantidad de la línea de la cola la escribió `plan_order_lines`
    // (Fact de sesión, no un número que el modelo pudo copiar del party size en
    // un retry): cuenta como cantidad dicha por el cliente. Si en este turno
    // manda otra (corrección: "mejor 3 papas"), gana la del turno.
    const lineQuantity = orderLine?.requestedQuantity ?? null;
    const qtyConfirmed =
      lineQuantity != null ||
      isConfirmedAddQuantity({
        quantity: quantity ?? null,
        suggestedQuantity,
        pendingReply,
      });
    const qty = qtyConfirmed
      ? Math.min(99, Math.max(1, Math.floor(quantity ?? lineQuantity ?? 1)))
      : 1;
    if (lineQuantity != null && quantity != null && quantity !== lineQuantity) {
      console.log(
        JSON.stringify({
          event: '[add_cart_item] order_line_quantity_overridden',
          conversationId,
          lineHint: orderLine?.hint ?? null,
          lineQuantity,
          quantityArg: quantity,
        })
      );
    }
    // Placeholder para variation_required (aún no confirmamos cantidad).
    const qtyForVariationPending = qtyConfirmed ? qty : suggestedQuantity;

    // D5 — el agente híbrido no adivina la variación: la tool lo obliga a
    // preguntar. Se resuelve ANTES de tocar draft_order_item, para que un
    // llamado sin variación (o con una inválida) no escriba nada.
    let resolvedVariation: string | null = null;
    if (hasVariations(item)) {
      if (!variation) {
        if (conversationId) {
          await setPendingVariation({
            conversationId,
            productId,
            productName: item.name,
            variations: item.variations,
            quantity: qtyForVariationPending,
          });
        }
        return toJson({
          success: false,
          error: 'variation_required',
          productName: item.name,
          variations: item.variations,
          pendingVariation: true,
        });
      }
      const match = matchVariation(variation, item.variations);
      if (match.status !== 'ok') {
        if (conversationId) {
          await setPendingVariation({
            conversationId,
            productId,
            productName: item.name,
            variations: item.variations,
            quantity: qtyForVariationPending,
          });
        }
        return toJson({
          success: false,
          error: 'variation_invalid',
          variations: item.variations,
          pendingVariation: true,
          ...(match.status === 'ambiguous' ? { candidates: match.candidates } : {}),
        });
      }
      resolvedVariation = match.value;
    }

    // D7 — cantidad: si party sugiere ≥2 y el cliente no dio número, no escribir.
    if (
      !qtyConfirmed &&
      conversationId &&
      needsAddQuantityConfirmation({ suggestedQuantity, partySize })
    ) {
      if (quantity != null) {
        console.log(
          JSON.stringify({
            event: '[add_cart_item] quantity_not_confirmed',
            conversationId,
            quantityArg: quantity,
            suggestedQuantity,
            partySize,
            pendingReply,
          })
        );
      }
      const pending = await setPendingAddQuantity({
        conversationId,
        productId,
        productName: item.name,
        suggestedQuantity,
        servesPeople: item.serves_people,
        partySize,
        variation: resolvedVariation,
        source: 'hybrid',
      });
      return toJson({
        success: false,
        error: 'quantity_required',
        productName: item.name,
        suggestedQuantity: pending.suggestedQuantity,
        partySize,
        servesPeople: item.serves_people,
        pendingAddQuantity: true,
        askMessage: buildPendingAddQuantityMessage(pending),
        instruction:
          'Mostrá askMessage (o equivalente) pidiendo cuántas unidades, con la sugerencia. ' +
          'NO digas que ya sumaste. NO reintentes add_cart_item con quantity en este mismo turno. ' +
          'NO llames present_complement_suggestions ni present_cart hasta confirmar.',
      });
    }

    // Producto sin variaciones: si el modelo mandó una de todos modos, se
    // ignora (no es un error; el modelo a veces manda campos de más).

    const resolved = resolveEffectivePrice(item);
    const unitPrice = resolved.finalPrice;

    // La variación es parte de la identidad de la línea (D4): una pizza
    // especial y una de roquefort son dos líneas, no una con cantidad 2.
    const existing = await prisma.draft_order_item.findFirst({
      where: { draft_order_id: draft.id, product_id: productId, variation: resolvedVariation },
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
          variation: resolvedVariation,
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

    let postAddOpportunity: PostAddComplementOpportunity | null = null;
    let queueFollowUp: { nextHint: string; remaining: number; instruction: string } | null = null;
    if (conversationId) {
      await clearPendingVariation(conversationId);
      await clearPendingAddQuantity(conversationId);
      await clearLastOffer(conversationId);
      await omitConversationMetadataKeys(conversationId, [
        ...PENDING_PRODUCT_SELECTION_KEYS,
      ]);
      await markComplementEngagedIfOffered(conversationId, productId);
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

      // D6/D7 — si este add cierra la línea activa de la cola de pedido,
      // avanzamos (el código, no el modelo) y decidimos si queda resto.
      let metadataAfterAdvance = stateForRevival?.metadata;
      let openOrderLinesAfterAdvance = false;
      if (hasOpenOrderLines(stateForRevival?.metadata)) {
        const nextPending = await advanceAfterLineClose({
          conversationId,
          metadata: stateForRevival?.metadata,
          lineId: orderLine?.id ?? null,
          closeStatus: 'done',
        });
        if (nextPending) {
          openOrderLinesAfterAdvance = true;
          queueFollowUp = buildOrderLinesContinueOrCancelHint(nextPending);
          metadataAfterAdvance = { ...(stateForRevival?.metadata as object), pendingOrderLines: nextPending };
        }
      }

      // El ESTADO DEL CLIENTE del turno se armó antes del add: reinyectamos
      // la Opportunity en la observación para el mismo turno ReAct.
      postAddOpportunity = await resolvePostAddComplementOpportunity({
        draftOrderId: draft.id,
        businessId,
        metadata: metadataAfterAdvance,
        hasOpenOrderLines: openOrderLinesAfterAdvance,
      });
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
        variation: resolvedVariation,
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
          variation: it.variation ?? null,
          quantity: it.quantity,
          notes: it.notes ?? null,
        })),
      },
      ...(queueFollowUp
        ? { queueFollowUp }
        : postAddOpportunity
          ? { opportunity: postAddOpportunity }
          : {
              followUp: {
                nextAction: 'present_cart',
                instruction:
                  'No hay ola de complemento ahora. Llamá present_cart para confirmar el add ' +
                  'con el pedido completo. PROHIBIDO listar categorías (Bebidas/Postres/Entradas) en prosa.',
              },
            }),
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
// determinístico de botones (`cart.service.ts`) para su
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

const updateItemNoteSchema = z
  .object({
    productId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'UUID del menu_item (get_cart.productId). Si hay ≥2 líneas con ese productId ' +
          'y no pasás draftOrderItemId(s), la tool devuelve ambiguous_lines.'
      ),
    draftOrderItemId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'UUID de UNA línea del carrito (get_cart.items[].id). Preferido cuando hay varias ' +
          'líneas del mismo plato (variaciones distintas).'
      ),
    draftOrderItemIds: z
      .array(z.string().uuid())
      .min(1)
      .max(20)
      .optional()
      .describe(
        'Varias líneas (get_cart.items[].id) para la misma nota — ej. el cliente dijo ' +
          '"las dos" / "todas" tras desambiguar.'
      ),
    note: z
      .string()
      .max(300)
      .describe(
        'Instrucción especial. Ej: "término medio", "sin cebolla", "poca sal". ' +
          'Cadena vacía para borrar la nota.'
      ),
  })
  .refine(
    (v) =>
      Boolean(v.draftOrderItemId) ||
      (v.draftOrderItemIds != null && v.draftOrderItemIds.length > 0) ||
      Boolean(v.productId),
    { message: 'Pasá draftOrderItemId, draftOrderItemIds o productId.' }
  );
type UpdateItemNoteInput = z.infer<typeof updateItemNoteSchema>;

type CartLineForNote = {
  id: string;
  product_id: string;
  variation: string | null;
  quantity: number;
  menu_item: { id: string; name: string } | null;
};

function mapNoteLineCandidate(it: CartLineForNote) {
  return {
    draftOrderItemId: it.id,
    productId: it.product_id,
    name: it.menu_item?.name ?? 'Producto',
    variation: it.variation ?? null,
    quantity: it.quantity,
  };
}

export const updateItemNoteTool = new DynamicStructuredTool<
  typeof updateItemNoteSchema,
  UpdateItemNoteInput
>({
  name: 'update_item_note',
  description:
    'Guarda (o reemplaza) la nota/instrucción especial de una o más líneas del carrito. ' +
    'Usá get_cart: cada ítem trae id (línea), productId, variation. ' +
    'Si el mismo plato aparece en ≥2 líneas y el cliente no aclaró alcance, pasá solo productId ' +
    'para recibir ambiguous_lines (preguntá si aplica a todas o a una). ' +
    'Con "las dos"/"todas" usá draftOrderItemIds; con una línea concreta, draftOrderItemId.',
  schema: updateItemNoteSchema,
  func: async (input: UpdateItemNoteInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone, conversationId } = getReactContext(config);
    const { productId, draftOrderItemId, draftOrderItemIds, note } = input;

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

    const lines = draft.draft_order_item as CartLineForNote[];
    const normalizedNote = note.trim() || null;

    let targets: CartLineForNote[] = [];

    if (draftOrderItemIds != null && draftOrderItemIds.length > 0) {
      const wanted = new Set(draftOrderItemIds);
      targets = lines.filter((it) => wanted.has(it.id));
      if (targets.length !== wanted.size) {
        return toJson({
          success: false,
          error: 'item_not_in_cart',
          hint: 'Algún draftOrderItemId no está en el carrito. Verificá con get_cart.',
        });
      }
    } else if (draftOrderItemId) {
      const line = lines.find((it) => it.id === draftOrderItemId);
      if (!line) {
        return toJson({
          success: false,
          error: 'item_not_in_cart',
          hint: 'Ese draftOrderItemId no está en el carrito. Verificá con get_cart.',
        });
      }
      targets = [line];
    } else if (productId) {
      const matches = lines.filter((it) => it.product_id === productId);
      if (matches.length === 0) {
        return toJson({
          success: false,
          error: 'item_not_in_cart',
          hint: 'El producto no está en el carrito activo. Verificá el productId con get_cart.',
        });
      }
      if (matches.length >= 2) {
        return toJson({
          success: false,
          error: 'ambiguous_lines',
          productId,
          productName: matches[0]?.menu_item?.name ?? null,
          candidates: matches.map(mapNoteLineCandidate),
          hint:
            'Hay varias líneas del mismo plato. Preguntá si la nota va en todas o en una ' +
            '(variación / ordinal). Luego reintentá con draftOrderItemIds (todas) o draftOrderItemId (una). ' +
            'Podés guardar noteText/candidateLineIds con start_item_note.',
        });
      }
      targets = [matches[0]!];
    }

    if (targets.length === 0) {
      return toJson({
        success: false,
        error: 'item_not_in_cart',
        hint: 'No se resolvió ninguna línea. Usá get_cart.',
      });
    }

    await prisma.$transaction(
      targets.map((line) =>
        prisma.draft_order_item.update({
          where: { id: line.id },
          data: { notes: normalizedNote },
        })
      )
    );

    if (conversationId) {
      await clearPendingItemNote(conversationId);
    }

    return toJson({
      success: true,
      note: normalizedNote,
      updatedCount: targets.length,
      items: targets.map((line) => ({
        draftOrderItemId: line.id,
        productId: line.product_id,
        itemName: line.menu_item?.name ?? 'Producto',
        variation: line.variation ?? null,
      })),
      // Compat con prompts viejos
      itemName: targets[0]?.menu_item?.name ?? 'Producto',
    });
  },
});

// ---------------------------------------------------------------------------
// start_item_note
// ---------------------------------------------------------------------------

const startItemNoteSchema = z.object({
  productId: z
    .string()
    .uuid()
    .optional()
    .describe('UUID del ítem si ya se sabe sobre cuál anotar; omitir si hay que pedir el plato.'),
  noteText: z
    .string()
    .max(300)
    .optional()
    .describe(
      'Nota ya dicha mientras se desambigua alcance (varias líneas del mismo plato).'
    ),
  candidateLineIds: z
    .array(z.string().uuid())
    .optional()
    .describe(
      'draft_order_item.id (get_cart.items[].id) candidatos cuando hay ≥2 líneas del mismo plato. Preferido.'
    ),
  candidateProductIds: z
    .array(z.string().uuid())
    .optional()
    .describe(
      'Legacy: productIds candidatos. Preferí candidateLineIds (varias líneas pueden compartir productId).'
    ),
});
type StartItemNoteInput = z.infer<typeof startItemNoteSchema>;

export const startItemNoteTool = new DynamicStructuredTool<
  typeof startItemNoteSchema,
  StartItemNoteInput
>({
  name: 'start_item_note',
  description:
    'Inicia el flujo de nota del pedido (tipable «Nota» / «Nota del pedido» sin texto de instrucción). ' +
    'Setea pendingItemNote y devuelve askMessage para mostrar al cliente. ' +
    'También sirve para dejar noteText/candidateLineIds mientras se desambigua si la nota ' +
    'aplica a todas las líneas o solo a una (tras ambiguous_lines). No escribe el carrito.',
  schema: startItemNoteSchema,
  func: async (input: StartItemNoteInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerPhone, conversationId } = getReactContext(config);

    const draft = await prisma.draft_order.findFirst({
      where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
      include: {
        draft_order_item: {
          include: { menu_item: { select: { id: true, name: true } } },
        },
      },
    });

    if (!draft || draft.draft_order_item.length === 0) {
      return toJson({
        success: false,
        error: 'empty_cart',
        hint: 'No hay ítems en el carrito para anotar. Pedí que sume algo primero.',
      });
    }

    const items = draft.draft_order_item;
    let productId: string | null | undefined = input.productId;
    let productName: string | null | undefined;

    if (productId) {
      const match = items.find((it) => it.product_id === productId);
      if (!match) {
        return toJson({
          success: false,
          error: 'item_not_in_cart',
          hint: 'Ese productId no está en el carrito. Usá get_cart.',
        });
      }
      productName = match.menu_item?.name ?? null;
    } else if (items.length === 1) {
      productId = items[0].product_id;
      productName = items[0].menu_item?.name ?? null;
    } else {
      productId = null;
      productName = null;
    }

    const pending = await setPendingItemNote({
      conversationId,
      productId,
      productName,
      noteText: input.noteText,
      candidateLineIds: input.candidateLineIds,
      candidateProductIds: input.candidateProductIds,
      source: 'hybrid',
    });

    const askMessage = buildPendingItemNoteMessage(
      items.length,
      pending.productName
    );

    return toJson({
      success: true,
      pending: true,
      askMessage,
      productId: pending.productId ?? null,
      productName: pending.productName ?? null,
      cartItemCount: items.length,
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
    'Usala cuando el cliente quiera ver qué tiene en el pedido, o tras add_cart_item si NO vas a ofrecer un complemento. ' +
    'No describas el carrito en texto: esta tool construye el mensaje interactivo completo.',
  schema: presentCartSchema,
  func: async (_input: PresentCartInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config); // validar contexto
    return toJson({ signal: 'present_cart' });
  },
});

// ---------------------------------------------------------------------------
// cancel_order (señal-UI — cancela draft y/o orden creada)
// ---------------------------------------------------------------------------

const cancelOrderSchema = z.object({
  target: z
    .enum(['draft', 'order'])
    .optional()
    .describe(
      'Opcional. "draft" = solo el carrito en armado; "order" = solo el pedido ya creado. ' +
        'Si hay ambos y no sabés cuál, omití target: el sistema desambigua con botones.'
    ),
});
type CancelOrderInput = z.infer<typeof cancelOrderSchema>;

export const cancelOrderTool = new DynamicStructuredTool<
  typeof cancelOrderSchema,
  CancelOrderInput
>({
  name: 'cancel_order',
  description:
    'Cancela el carrito (draft) y/o un pedido YA CREADO (previo a entregado). ' +
    'Usala cuando el cliente diga "cancela el pedido", "borrá el carrito", "no quiero el pedido", etc. ' +
    'NO inventes un mensaje de cancelado en prosa: esta tool ejecuta la cancelación real. ' +
    'Si hay carrito Y pedido confirmado a la vez, omití target para que el sistema pregunte cuál. ' +
    'Si [ESTADO DEL CLIENTE] pide elegir carrito vs pedido, llamá con target draft u order.',
  schema: cancelOrderSchema,
  func: async ({ target }: CancelOrderInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config);
    return toJson({
      signal: 'cancel_order',
      ...(target ? { target } : {}),
    });
  },
});

// ---------------------------------------------------------------------------
// present_complement_suggestions (señal-UI — upsell model-led)
// ---------------------------------------------------------------------------

const presentComplementSuggestionsSchema = z.object({
  productId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'UUID del último producto sumado (preferido). Si se omite, se usa el ítem más reciente del carrito.'
    ),
});
type PresentComplementSuggestionsInput = z.infer<typeof presentComplementSuggestionsSchema>;

export const presentComplementSuggestionsTool = new DynamicStructuredTool<
  typeof presentComplementSuggestionsSchema,
  PresentComplementSuggestionsInput
>({
  name: 'present_complement_suggestions',
  description:
    'Ofrece una lista interactiva para completar el menú (hasta 2 categorías: entrada, principal, bebida, postre). ' +
    'Usala tras add_cart_item cuando [ESTADO DEL CLIENTE] tenga Opportunity opcional SUGERIR_COMPLEMENTO. ' +
    'No la combines con present_cart en el mismo turno. ' +
    'El runtime omite la lista si el cliente ya rechazó, está en cooldown, o no hay huecos.',
  schema: presentComplementSuggestionsSchema,
  func: async (
    { productId }: PresentComplementSuggestionsInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    getReactContext(config);
    return toJson({
      signal: 'present_complement_suggestions',
      ...(productId ? { productId } : {}),
    });
  },
});

const markComplementRefusedSchema = z.object({});
type MarkComplementRefusedInput = z.infer<typeof markComplementRefusedSchema>;

export const markComplementRefusedTool = new DynamicStructuredTool<
  typeof markComplementRefusedSchema,
  MarkComplementRefusedInput
>({
  name: 'mark_complement_refused',
  description:
    'Registra que el cliente rechazó completar el menú (dijo no / mejor no / sin postre / no gracias a la oferta de complementos). ' +
    'Llamá ANTES de responder. Después de esto NO vuelvas a ofrecer present_complement_suggestions en este pedido.',
  schema: markComplementRefusedSchema,
  func: async (_input: MarkComplementRefusedInput, _runManager, config?: RunnableConfig) => {
    const { conversationId } = getReactContext(config);
    await markComplementRefused(conversationId);
    return toJson({ refused: true });
  },
});

const clearPendingAddQuantitySchema = z.object({});
type ClearPendingAddQuantityInput = z.infer<typeof clearPendingAddQuantitySchema>;

export const clearPendingAddQuantityTool = new DynamicStructuredTool<
  typeof clearPendingAddQuantitySchema,
  ClearPendingAddQuantityInput
>({
  name: 'clear_pending_add_quantity',
  description:
    'Cancela la confirmación de cantidad pendiente (el cliente dijo cancelar / no / mejor no a “¿cuántas unidades?”). ' +
    'Llamá ANTES de responder. No suma nada al carrito.',
  schema: clearPendingAddQuantitySchema,
  func: async (
    _input: ClearPendingAddQuantityInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { conversationId } = getReactContext(config);
    if (conversationId) {
      await clearPendingAddQuantity(conversationId);
    }
    return toJson({ cleared: true });
  },
});

const clearPendingVariationSchema = z.object({});
type ClearPendingVariationInput = z.infer<typeof clearPendingVariationSchema>;

export const clearPendingVariationTool = new DynamicStructuredTool<
  typeof clearPendingVariationSchema,
  ClearPendingVariationInput
>({
  name: 'clear_pending_variation',
  description:
    'Cancela la elección de variedad pendiente (el cliente dijo cancelar / no / mejor no / otro plato). ' +
    'Llamá ANTES de responder. No suma nada al carrito.',
  schema: clearPendingVariationSchema,
  func: async (
    _input: ClearPendingVariationInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { conversationId } = getReactContext(config);
    if (conversationId) {
      await clearPendingVariation(conversationId);
    }
    return toJson({ cleared: true });
  },
});

const clearPendingItemNoteSchema = z.object({});
type ClearPendingItemNoteInput = z.infer<typeof clearPendingItemNoteSchema>;

export const clearPendingItemNoteTool = new DynamicStructuredTool<
  typeof clearPendingItemNoteSchema,
  ClearPendingItemNoteInput
>({
  name: 'clear_pending_item_note',
  description:
    'Cancela el flujo de nota del pedido (el cliente dijo cancelar / mejor no / nada). ' +
    'Llamá ANTES de responder. No modifica notas del carrito.',
  schema: clearPendingItemNoteSchema,
  func: async (
    _input: ClearPendingItemNoteInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { conversationId } = getReactContext(config);
    if (conversationId) {
      await clearPendingItemNote(conversationId);
    }
    return toJson({ cleared: true });
  },
});

// ---------------------------------------------------------------------------
// plan_order_lines — cola de líneas de pedido (D1/D2 de
// PLAN-ACCION-PEDIDO-MULTI-LINEA.md)
// ---------------------------------------------------------------------------

const planOrderLinesSchema = z.object({
  lines: z
    .array(
      z.object({
        hint: z
          .string()
          .min(1)
          .describe(
            'Solo el NOMBRE del plato/categoría a buscar, SIN el número de unidades ' +
              '(ej. "lomo saltado", "ceviche", "bebida"). El número va en requestedQuantity, ' +
              'nunca acá. NO es un productId.'
          ),
        requestedQuantity: z
          .number()
          .int()
          .min(1)
          .max(99)
          .optional()
          .describe(
            'Unidades que el cliente pidió para ESTA línea en el mismo mensaje. ' +
              '"3 lomos" → { hint: "lomo saltado", requestedQuantity: 3 }. ' +
              '"1 ceviche" → { hint: "ceviche", requestedQuantity: 1 }. ' +
              'Omití solo si no dijo número ("quiero ceviche", "una bebida"). ' +
              'Mandarlo mal obliga al bot a preguntar cuántas personas comen: el dato importa.'
          ),
      })
    )
    .min(2)
    .max(ORDER_LINES_MAX)
    .describe(
      `Entre 2 y ${ORDER_LINES_MAX} líneas, una por cada plato/categoría distinto que el cliente pidió en el mensaje.`
    ),
});
type PlanOrderLinesInput = z.infer<typeof planOrderLinesSchema>;

export const planOrderLinesTool = new DynamicStructuredTool<
  typeof planOrderLinesSchema,
  PlanOrderLinesInput
>({
  name: 'plan_order_lines',
  description:
    'Partí el pedido del cliente en líneas cuando el mensaje trae 2 o más platos/categorías distintos ' +
    '(ej. "quiero 3 lomos, 2 ceviches y una bebida" → 3 líneas). NO uses esta tool si es un solo plato ' +
    '(aunque pida varias unidades del mismo, ej. "2 pizzas" es 1 línea, no la necesitás). ' +
    'Llamala UNA sola vez por mensaje, ANTES de resolver ningún producto. Después de llamarla, trabajá ' +
    'SOLO la línea activa que te indique la respuesta (o [ESTADO DEL CLIENTE] en el siguiente turno): ' +
    'search_products/find_products_by_filter con su hint, variación y cantidad como el flujo normal — ' +
    'las demás líneas esperan en cola, no las menciones como shortlist.',
  schema: planOrderLinesSchema,
  func: async (
    { lines }: PlanOrderLinesInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { conversationId } = getReactContext(config);
    if (!conversationId) {
      return toJson({ success: false, error: 'no_conversation' });
    }
    const pending = await setPendingOrderLines({
      conversationId,
      lines,
      sourceMessage: lines.map((l) => l.hint).join(', '),
    });
    const active = getActiveOrderLine(pending);
    return toJson({
      success: true,
      activeLine: active
        ? { hint: active.hint, requestedQuantity: active.requestedQuantity }
        : null,
      queuedCount: pending.lines.filter((l) => l.status === 'queued').length,
      instruction: active
        ? `Trabajá ahora SOLO "${active.hint}"${
            active.requestedQuantity ? ` (${active.requestedQuantity}×)` : ''
          } con search_products/find_products_by_filter. No listes ni menciones las demás líneas todavía.`
        : 'Sin línea activa (inesperado): revisá con get_cart.',
    });
  },
});

const continueOrderLineSchema = z.object({});
type ContinueOrderLineInput = z.infer<typeof continueOrderLineSchema>;

export const continueOrderLineTool = new DynamicStructuredTool<
  typeof continueOrderLineSchema,
  ContinueOrderLineInput
>({
  name: 'continue_order_line',
  description:
    'El cliente confirmó que seguimos con la próxima línea de la cola de pedido ("seguí", "dale con el ceviche", "sí"). ' +
    'Actívala (el sistema decide cuál es) y devuelve su hint/cantidad para que llames search_products/find_products_by_filter ' +
    'en este mismo turno. Si no hay cola o ya hay una línea activa, no hace nada.',
  schema: continueOrderLineSchema,
  func: async (
    _input: ContinueOrderLineInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { conversationId } = getReactContext(config);
    if (!conversationId) {
      return toJson({ success: false, error: 'no_conversation' });
    }
    const state = await findOrCreateConversationState(conversationId);
    const pending = await activateNextOrderLine(conversationId, state.metadata);
    const active = getActiveOrderLine(pending);
    if (!active) {
      return toJson({ success: false, error: 'no_pending_order_lines' });
    }
    return toJson({
      success: true,
      activeLine: { hint: active.hint, requestedQuantity: active.requestedQuantity },
      instruction: `Trabajá ahora "${active.hint}"${
        active.requestedQuantity ? ` (${active.requestedQuantity}×)` : ''
      } con search_products/find_products_by_filter.`,
    });
  },
});

const cancelOrderLineSchema = z.object({
  hint: z
    .string()
    .optional()
    .describe(
      'Texto de la línea a cancelar si el cliente nombró cuál (ej. "el ceviche"). ' +
        'Omití para cancelar la línea activa.'
    ),
});
type CancelOrderLineInput = z.infer<typeof cancelOrderLineSchema>;

export const cancelOrderLineTool = new DynamicStructuredTool<
  typeof cancelOrderLineSchema,
  CancelOrderLineInput
>({
  name: 'cancel_order_line',
  description:
    'Cancela UNA línea puntual de la cola de pedido (el cliente no quiere ese plato: "el ceviche no", ' +
    '"mejor sin bebida"). Para cancelar TODO el resto de la cola usá clear_pending_order_lines en cambio.',
  schema: cancelOrderLineSchema,
  func: async (
    { hint }: CancelOrderLineInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { conversationId } = getReactContext(config);
    if (!conversationId) {
      return toJson({ success: false, error: 'no_conversation' });
    }
    const state = await findOrCreateConversationState(conversationId);
    const nextPending = await cancelOrderLine({
      conversationId,
      metadata: state.metadata,
      hint: hint ?? null,
    });
    const queueFollowUp = nextPending
      ? buildOrderLinesContinueOrCancelHint(nextPending)
      : null;
    return toJson({
      cancelled: true,
      ...(queueFollowUp ? { queueFollowUp } : { queueEmpty: true }),
    });
  },
});

const clearPendingOrderLinesSchema = z.object({});
type ClearPendingOrderLinesInput = z.infer<typeof clearPendingOrderLinesSchema>;

export const clearPendingOrderLinesTool = new DynamicStructuredTool<
  typeof clearPendingOrderLinesSchema,
  ClearPendingOrderLinesInput
>({
  name: 'clear_pending_order_lines',
  description:
    'Cancela TODO el resto de la cola de pedido (el cliente dijo "nada más", "cancelá el resto", "listo así"). ' +
    'No toca lo que ya está en el carrito. Llamá ANTES de responder. ' +
    'NO la uses si el cliente quiere cancelar el pedido / el carrito / todo ("cancelar pedido", ' +
    '"cancelá todo", "borrá el carrito"): eso es cancel_order(), que además vacía el carrito.',
  schema: clearPendingOrderLinesSchema,
  func: async (
    _input: ClearPendingOrderLinesInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { conversationId, businessId, customerPhone } = getReactContext(config);
    if (conversationId) {
      await clearPendingOrderLines(conversationId);
    }

    // El carrito sobrevive a esta tool: el copy debe decirlo (el cliente que
    // pidió "cancelar pedido" cree que se vació todo).
    const draft = await prisma.draft_order.findFirst({
      where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
      select: { draft_order_item: { select: { quantity: true } } },
    });
    const cartItemCount = draft?.draft_order_item.length ?? 0;

    return toJson({
      cleared: true,
      cartItemCount,
      instruction:
        cartItemCount > 0
          ? 'Solo se cancelaron las líneas que faltaban: el carrito sigue con lo ya sumado. ' +
            'Decilo explícitamente (podés usar present_cart). Si el cliente quería cancelar TODO ' +
            'el pedido, llamá cancel_order() en este mismo turno.'
          : 'La cola quedó vacía y el carrito no tiene ítems.',
    });
  },
});

// ---------------------------------------------------------------------------
// present_category (señal-UI — misma lista que el botón CATEGORY)
// ---------------------------------------------------------------------------

const presentCategorySchema = z.object({
  categoryId: z
    .string()
    .uuid()
    .describe('UUID de la categoría (campo id de get_categories, o el UUID de payload CATEGORY:{id}).'),
});
type PresentCategoryInput = z.infer<typeof presentCategorySchema>;

export const presentCategoryTool = new DynamicStructuredTool<
  typeof presentCategorySchema,
  PresentCategoryInput
>({
  name: 'present_category',
  description:
    'Muestra la lista interactiva de platillos de una categoría (igual que si el cliente tocara esa categoría). ' +
    'Usala cuando el cliente escribe el nombre de una categoría en texto libre. Primero get_categories para ' +
    'obtener el categoryId. No listés los platos en texto: esta tool arma el mensaje completo.',
  schema: presentCategorySchema,
  func: async (input: PresentCategoryInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config);
    return toJson({ signal: 'present_category', categoryId: input.categoryId });
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
// present_product_cta (señal-UI — el agente decide si ofrecer botones/lista)
// ---------------------------------------------------------------------------

const presentProductCtaSchema = z.object({
  primaryKind: z
    .enum(['ADD_ITEM', 'SELECT_FROM_LIST', 'VIEW_MENU', 'VIEW_FEATURED'])
    .describe(
      'ADD_ITEM: un solo producto para sumar. SELECT_FROM_LIST: 2+ productos para elegir. ' +
        'VIEW_MENU / VIEW_FEATURED: explorar sin producto concreto.'
    ),
  productHint: z
    .string()
    .nullable()
    .optional()
    .describe('Nombre del producto para ADD_ITEM (si no tenés productId).'),
  productHints: z
    .array(z.string())
    .nullable()
    .optional()
    .describe('Nombres (fallback) para SELECT_FROM_LIST si no tenés productIds.'),
  productIds: z
    .array(z.string().uuid())
    .min(2)
    .max(10)
    .nullable()
    .optional()
    .describe(
      'UUIDs del shortlist (search_products / find_products_by_filter) para SELECT_FROM_LIST. ' +
        'Preferido: 2–10 ids en el mismo orden que devolvió la tool.'
    ),
  productId: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .describe('UUID del menu_item si ya lo tenés (preferido para ADD_ITEM).'),
  quantity: z
    .number()
    .int()
    .min(1)
    .max(99)
    .optional()
    .describe('Cantidad para ADD_ITEM (default 1).'),
  primaryLabel: z
    .string()
    .max(20)
    .optional()
    .describe('Texto del botón primario (máx 20). Ej: "Agregar 🛒", "Ver menú".'),
  secondaryKind: z
    .enum(['VIEW_MENU', 'VIEW_FEATURED'])
    .nullable()
    .optional()
    .describe('Botón de escape. Obligatorio en la práctica con ADD_ITEM.'),
  secondaryLabel: z.string().max(20).nullable().optional(),
});
type PresentProductCtaInput = z.infer<typeof presentProductCtaSchema>;

export const presentProductCtaTool = new DynamicStructuredTool<
  typeof presentProductCtaSchema,
  PresentProductCtaInput
>({
  name: 'present_product_cta',
  description:
    'Adjunta botones o una lista de productos a TU respuesta de texto (un solo mensaje). ' +
    'Tras search_products/find_products_by_filter con count ≥ 2: primaryKind=SELECT_FROM_LIST y ' +
    'productIds = los id del shortlist; tu texto es SOLO la intro (sin listar platos, porciones ni precios: ' +
    'el sistema los pone en los atajos tipables). ' +
    'NO la uses si ya resolviste sin UI (nota, quitar ítem, cierre "¿algo más?").',
  schema: presentProductCtaSchema,
  func: async (input: PresentProductCtaInput, _runManager, config?: RunnableConfig) => {
    getReactContext(config);
    return toJson({
      signal: 'present_product_cta',
      primaryKind: input.primaryKind,
      productHint: input.productHint ?? null,
      productHints: input.productHints ?? null,
      productIds: input.productIds ?? null,
      productId: input.productId ?? null,
      quantity: input.quantity ?? 1,
      primaryLabel: input.primaryLabel ?? null,
      secondaryKind: input.secondaryKind ?? null,
      secondaryLabel: input.secondaryLabel ?? null,
    });
  },
});

// ---------------------------------------------------------------------------
// get_order_status (híbrido — seguimiento de un pedido YA creado)
// ---------------------------------------------------------------------------

const getOrderStatusSchema = z.object({});
type GetOrderStatusInput = z.infer<typeof getOrderStatusSchema>;

export const getOrderStatusTool = new DynamicStructuredTool<
  typeof getOrderStatusSchema,
  GetOrderStatusInput
>({
  name: 'get_order_status',
  description:
    'Devuelve TODOS los pedidos YA CREADOS del cliente que todavía no fueron entregados (puede tener ' +
    'varios pedidos activos el mismo día) — no confundir con get_cart, que es el carrito ANTES de crear ' +
    'la orden. Usala cuando el cliente pregunta por un pedido ya hecho ("¿cómo va mi pedido?", "¿ya está ' +
    'listo?", "¿dónde está?", "¿lo entregaron?"). Devuelve exists (false si no tiene pedidos activos), y ' +
    'si exists: orders (array, ordenado del más viejo al más nuevo). Cada pedido trae "index" (1, 2, 3... ' +
    'en ese orden — usalo para nombrarlo "pedido 1", "pedido 2" si hay más de uno, nunca inventes otra ' +
    'numeración), orderRef (código corto alternativo), status (en español, ya legible), paymentStatus, ' +
    'fulfillmentType, totalAmount, currencyCode, createdAt, items (nombre y cantidad).',
  schema: getOrderStatusSchema,
  func: async (_input: GetOrderStatusInput, _runManager, config?: RunnableConfig) => {
    const { businessId, customerId } = getReactContext(config);
    const orders = await prisma.orders.findMany({
      where: {
        business_id: businessId,
        customer_id: customerId,
        // Solo pedidos "en curso" — entregado/cancelado son historial cerrado
        // (nada que rastrear) y draft es vestigial (los pedidos se crean
        // directo en 'placed', nunca queda uno de verdad en este estado).
        status: {
          in: [OrderStatus.placed, OrderStatus.preparing, OrderStatus.shipped, OrderStatus.ready_for_pickup],
        },
      },
      orderBy: { created_at: 'asc' },
      include: {
        order_item: { include: { menu_item: { select: { name: true } } } },
      },
    });

    if (orders.length === 0) {
      return toJson({ exists: false });
    }

    return toJson({
      exists: true,
      orders: orders.map((order, idx) => ({
        index: idx + 1,
        orderRef: shortOrderRef(order.id),
        status: ORDER_STATUS_LABEL_ES[order.status],
        paymentStatus: ORDER_PAYMENT_STATUS_LABEL_ES[order.payment_status],
        fulfillmentType: order.fulfillment_type,
        totalAmount: order.total_amount?.toFixed(2) ?? null,
        currencyCode: order.currency_code,
        createdAt: order.created_at.toISOString(),
        items: order.order_item.map((it) => ({
          name: it.menu_item?.name ?? 'Producto',
          quantity: it.quantity,
        })),
      })),
    });
  },
});

// ---------------------------------------------------------------------------
// abandon_pending_order (Ledger — ADR-0005/0007/0008)
//
// DESCONECTADA del agente (2026-08): queda el código por si se retoma.
// Motivo: sin vencimiento de carrito, un draft "abandonado" (bot deja de
// insistir pero el carrito sigue) no aporta y genera zombies. El anti-
// cansancio del Goal queda en presupuesto/cooldown; cancelar pedido = cancel
// real (draft/orden), no esta tool.
// NO está en `allReactTools`.
// ---------------------------------------------------------------------------

const abandonPendingOrderSchema = z.object({});
type AbandonPendingOrderInput = z.infer<typeof abandonPendingOrderSchema>;

export const abandonPendingOrderTool = new DynamicStructuredTool<
  typeof abandonPendingOrderSchema,
  AbandonPendingOrderInput
>({
  name: 'abandon_pending_order',
  description:
    'DESCONECTADA — no exponer al agente. Registraba que el cliente pidió dejar de insistir ' +
    'con el pedido pendiente sin borrar el carrito (solo silenciaba COMPLETAR_PEDIDO).',
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

// ---------------------------------------------------------------------------
// request_human_support (interrupt — escalado a humano desde el ReAct)
// ---------------------------------------------------------------------------

const requestHumanSupportSchema = z.object({
  reason: z
    .string()
    .describe(
      'Motivo del escalado en una oración. Ej: "el cliente pidió hablar con un asesor", ' +
        '"el cliente quiere atención personalizada".'
    ),
});
type RequestHumanSupportInput = z.infer<typeof requestHumanSupportSchema>;

/**
 * `escalationGateNode` sigue siendo el interrupt determinista que corre en todo
 * turno (incluidas las sesiones donde el ReAct no llega). Esta tool cubre lo que
 * ese gate deja pasar por diseño: pedidos de humano en prosa que no matchean sus
 * patrones conservadores ("necesito soporte", "me pasan con un asesor?").
 *
 * Aplica el efecto acá (misma semántica que el gate y que el botón SUPPORT), no
 * en el prompt: `is_human_handled` corta los turnos siguientes en
 * `buildDetectionContextNode`.
 */
export const requestHumanSupportTool = new DynamicStructuredTool<
  typeof requestHumanSupportSchema,
  RequestHumanSupportInput
>({
  name: 'request_human_support',
  description:
    'Deriva la conversación a una persona del equipo cuando el cliente pide hablar con un humano, ' +
    'un asesor, soporte o atención personalizada ("necesito hablar con alguien", "me comunican con un ' +
    'asesor?", "quiero atención humana", "no quiero seguir con un bot"). ' +
    'Tras llamarla el bot deja de responder hasta que un asesor retome: NO agregues más preguntas. ' +
    'No la uses para consultas que podés resolver con tus otras tools (menú, precios, horarios, pedido).',
  schema: requestHumanSupportSchema,
  func: async (
    { reason }: RequestHumanSupportInput,
    _runManager,
    config?: RunnableConfig
  ) => {
    const { conversationId, businessId, customerId, customerPhone } =
      getReactContext(config);

    await handOverToHuman({
      conversationId,
      businessId,
      customer: { id: customerId, phone_number: customerPhone },
      reason: `hybrid_tool:${reason}`,
    });

    return toJson({ signal: 'request_human_support', reason, message: SUPPORT_MESSAGE });
  },
});

export const allReactTools = [
  searchProductsTool,
  getProductsDetailsByIdsTool,
  getFeaturedProductsTool,
  getCategoriesTool,
  getMenuByCategoryTool,
  getCartTool,
  getPaymentMethodsTool,
  getPopularProductsTool,
  getBusinessHoursTool,
  getRecentMessagesTool,
  findProductsByFilterTool,
  checkProductAvailabilityTool,
  getComplementarySuggestionsTool,
  getBusinessInfoTool,
  addCartItemTool,
  removeCartItemTool,
  updateItemNoteTool,
  startItemNoteTool,
  savePartySizeTool,
  presentCartTool,
  cancelOrderTool,
  presentComplementSuggestionsTool,
  markComplementRefusedTool,
  clearPendingAddQuantityTool,
  clearPendingVariationTool,
  clearPendingItemNoteTool,
  planOrderLinesTool,
  continueOrderLineTool,
  cancelOrderLineTool,
  clearPendingOrderLinesTool,
  presentCategoryTool,
  presentWelcomeOptionsTool,
  presentProductCtaTool,
  // abandonPendingOrderTool — desconectada a propósito (ver comentario arriba)
  abandonPendingReservationTool,
  stageDeliveryAddressTool,
  presentAddressConfirmationTool,
  checkDeliveryCoverageTool,
  getOrderStatusTool,
  requestHumanSupportTool,
];
