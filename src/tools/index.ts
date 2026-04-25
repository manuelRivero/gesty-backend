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
 *
 * Uso: ver `src/agents/reactAgent.ts`.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { MenuService } from '../services/menu.service';
import { getBusinessOpenInfo } from '../services/businessHours.service';
import { findRecentMessagesForDetectionContext } from '../repositories';
import { prisma } from '../lib/prisma';

const toJson = (data: unknown): string => {
  try {
    return JSON.stringify(data, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value
    );
  } catch {
    return JSON.stringify({ error: 'unserializable_result' });
  }
};

const searchProductsSchema = z.object({
  businessId: z.string().describe('ID del negocio (UUID)'),
  keyword: z.string().min(1).describe('Palabra clave o nombre a buscar'),
});
type SearchProductsInput = z.infer<typeof searchProductsSchema>;

export const searchProductsTool = new DynamicStructuredTool<
  typeof searchProductsSchema,
  SearchProductsInput
>({
  name: 'search_products',
  description:
    'Busca productos del menú por palabra clave (nombre o ingrediente). Devuelve hasta 10 resultados con id, nombre, descripción, ingredientes, porciones y precios.',
  schema: searchProductsSchema,
  func: async ({ businessId, keyword }: SearchProductsInput) => {
    const items = await MenuService.searchMenuItemsByKeyword({
      businessId,
      keyword,
    });
    const trimmed = items.slice(0, 10).map((item) => ({
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
    }));
    return toJson({ count: trimmed.length, items: trimmed });
  },
});

const getCategoriesSchema = z.object({
  businessId: z.string(),
  customerId: z.string(),
});
type GetCategoriesInput = z.infer<typeof getCategoriesSchema>;

export const getCategoriesTool = new DynamicStructuredTool<
  typeof getCategoriesSchema,
  GetCategoriesInput
>({
  name: 'get_categories',
  description:
    'Devuelve la lista de categorías de menú visibles para el cliente.',
  schema: getCategoriesSchema,
  func: async ({ businessId, customerId }: GetCategoriesInput) => {
    const res = await MenuService.getCategoryListForCustomer({
      businessId,
      customerId,
    });
    return toJson({
      text: res.text,
      categories: res.buttons.map((b) => ({
        title: b.title,
        payload: b.payload,
      })),
    });
  },
});

const getMenuByCategorySchema = z.object({
  businessId: z.string(),
  customerId: z.string(),
  categoryId: z.string(),
});
type GetMenuByCategoryInput = z.infer<typeof getMenuByCategorySchema>;

export const getMenuByCategoryTool = new DynamicStructuredTool<
  typeof getMenuByCategorySchema,
  GetMenuByCategoryInput
>({
  name: 'get_menu_by_category',
  description:
    'Devuelve los items del menú de una categoría específica (lectura).',
  schema: getMenuByCategorySchema,
  func: async ({ businessId, customerId, categoryId }: GetMenuByCategoryInput) => {
    const res = await MenuService.getItemsByCategory({
      businessId,
      customerId,
      categoryId,
    });
    return toJson({
      text: res.text,
      items: res.buttons.map((b) => ({ title: b.title, payload: b.payload })),
    });
  },
});

const getCartSchema = z.object({
  businessId: z.string(),
  customerPhone: z.string(),
});
type GetCartInput = z.infer<typeof getCartSchema>;

/**
 * Carrito actual (`draft_order` activo) — snapshot read-only.
 */
export const getCartTool = new DynamicStructuredTool<
  typeof getCartSchema,
  GetCartInput
>({
  name: 'get_cart',
  description:
    'Devuelve el contenido del carrito activo (draft order) del cliente, sin modificarlo.',
  schema: getCartSchema,
  func: async ({ businessId, customerPhone }: GetCartInput) => {
    const draft = await prisma.draft_order.findFirst({
      where: {
        business_id: businessId,
        customer_phone: customerPhone,
        status: 'active',
      },
      include: {
        draft_order_item: {
          include: {
            menu_item: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!draft) {
      return toJson({ exists: false, items: [] });
    }

    return toJson({
      exists: true,
      draftOrderId: draft.id,
      expiresAt: draft.expires_at?.toISOString() ?? null,
      items: draft.draft_order_item.map((it) => ({
        id: it.id,
        productId: it.product_id,
        menuItemName: it.menu_item?.name ?? null,
        quantity: it.quantity,
        unitPrice: it.unit_price.toString(),
        totalPrice: it.total_price.toString(),
      })),
    });
  },
});

const getBusinessHoursSchema = z.object({
  businessId: z.string(),
});
type GetBusinessHoursInput = z.infer<typeof getBusinessHoursSchema>;

export const getBusinessHoursTool = new DynamicStructuredTool<
  typeof getBusinessHoursSchema,
  GetBusinessHoursInput
>({
  name: 'get_business_hours',
  description:
    'Devuelve si el negocio está abierto ahora y los horarios del día actual / próximo.',
  schema: getBusinessHoursSchema,
  func: async ({ businessId }: GetBusinessHoursInput) => {
    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: { id: true, timezone: true },
    });
    if (!business?.timezone) {
      return toJson({ error: 'business_timezone_missing' });
    }

    const info = await getBusinessOpenInfo({
      businessId: business.id,
      timezone: business.timezone,
    });
    return toJson(info);
  },
});

const getRecentMessagesSchema = z.object({
  conversationId: z.string(),
  sinceStartedAt: z
    .string()
    .describe('ISO-8601: límite inferior de created_at'),
  take: z.number().int().positive().max(50).default(10),
});
type GetRecentMessagesInput = z.infer<typeof getRecentMessagesSchema>;

export const getRecentMessagesTool = new DynamicStructuredTool<
  typeof getRecentMessagesSchema,
  GetRecentMessagesInput
>({
  name: 'get_recent_messages',
  description:
    'Devuelve los últimos N mensajes de la conversación desde una fecha de inicio (más recientes primero).',
  schema: getRecentMessagesSchema,
  func: async ({
    conversationId,
    sinceStartedAt,
    take,
  }: GetRecentMessagesInput) => {
    const since = new Date(sinceStartedAt);
    const messages = await findRecentMessagesForDetectionContext(
      conversationId,
      since,
      take
    );
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

export const allReactTools = [
  searchProductsTool,
  getCategoriesTool,
  getMenuByCategoryTool,
  getCartTool,
  getBusinessHoursTool,
  getRecentMessagesTool,
];
