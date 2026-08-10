import {
  business as BusinessType,
  conversation as ConversationType,
  MenuCategoryTag,
} from '@prisma/client';
import { WhatsAppListMessage } from '../domain/intent/whatsappTemplates';
import { prisma } from '../lib/prisma';
import { createConversationMessage, findOrCreateConversationState, createOrGetOpenConversation, findOrCreateCustomer, updateConversationLastMessageAt, findBusinessByPhoneNumberId } from '../repositories';
import { truncateDescription, truncateTitle } from '../whatsappBuilders';
import {
  buildShortcutsThenListBody,
  shortcutBullet,
} from '../whatsappBuilders/listShortcutsBody';
import { WhatsAppWebhookPayload } from '../controllers/webhook/types';

interface CategoryMessageResult {
    message: WhatsAppListMessage | null;
    errorMessage?: string;
    conversationUpdated: boolean;
}

interface ViewCategoriesResult {
    message: WhatsAppListMessage | null;
    errorMessage?: string;
}

interface CategoryMessageResult {
    message: WhatsAppListMessage | null;
    errorMessage?: string;
    conversationUpdated: boolean;
}

interface ProductSummary {
    title: string;
    payload: string;
    description: string;
    sectionTitle: string;
}

const buildProductListPages = (
    items: ProductSummary[],
    categoryId: string,
    pageSize = 10
): Array<{ buttons: ProductSummary[] }> => {
    const pages: Array<{ buttons: ProductSummary[] }> = [];

    for (let i = 0; i < items.length; i += pageSize) {
        const pageItems = items.slice(i, i + pageSize);

        // Agregar navegación si hay más páginas
        const buttons = [...pageItems];

        const currentPage = Math.floor(i / pageSize) + 1;
        const totalPages = Math.ceil(items.length / pageSize);

        if (currentPage < totalPages) {
            buttons.push({
                title: 'Siguiente página →',
                payload: `CATEGORY_PAGE:${categoryId}:${currentPage + 1}`,
                description: 'Ver más platillos',
                sectionTitle: 'Navegación'
            });
        }

        pages.push({ buttons });
    }

    return pages;
};

const TAG_LIST_LABEL: Record<MenuCategoryTag, string> = {
  STARTER: 'Entradas',
  MAIN: 'Platos principales',
  SIDE: 'Guarniciones',
  DRINK: 'Bebidas',
  DESSERT: 'Postres',
  OTHER: 'Otros',
};

const buildProductListPagesForTag = (
  items: ProductSummary[],
  tag: MenuCategoryTag,
  pageSize = 9
): Array<{ buttons: ProductSummary[] }> => {
  const pages: Array<{ buttons: ProductSummary[] }> = [];

  for (let i = 0; i < items.length; i += pageSize) {
    const pageItems = items.slice(i, i + pageSize);
    const buttons = [...pageItems];

    const currentPage = Math.floor(i / pageSize) + 1;
    const totalPages = Math.ceil(items.length / pageSize);

    if (currentPage < totalPages) {
      buttons.push({
        title: 'Siguiente página →',
        payload: `MENU_BY_TAG:${tag}:${currentPage + 1}`,
        description: 'Ver más platillos',
        sectionTitle: 'Navegación',
      });
    }

    pages.push({ buttons });
  }

  return pages;
};

export const buildMenuListByCategoryTagMessage = async (
  business: BusinessType,
  conversation: ConversationType,
  tag: MenuCategoryTag,
  page = 1
): Promise<CategoryMessageResult> => {
  const businessCurrency = await prisma.business.findUnique({
    where: { id: business.id },
    select: { currency_code: true },
  });

  const currency = businessCurrency?.currency_code;
  const now = new Date();
  const priceWhere = {
    currency_code: currency ?? undefined,
    is_active: true,
    valid_from: { lte: now },
    OR: [{ valid_to: null }, { valid_to: { gte: now } }],
  };

  const items = await prisma.menu_item.findMany({
    where: {
      business_id: business.id,
      is_available: true,
      menu_category: {
        business_id: business.id,
        is_active: true,
        category_tag: tag,
      },
      menu_item_price: {
        some: priceWhere,
      },
    },
    orderBy: [{ menu_category: { name: 'asc' } }, { name: 'asc' }],
    include: {
      menu_category: { select: { name: true } },
      menu_item_price: {
        where: priceWhere,
        orderBy: { valid_from: 'desc' },
        take: 1,
      },
    },
  });

  if (items.length === 0) {
    const label = TAG_LIST_LABEL[tag];
    const errorText = `No hay platillos disponibles en *${label}*.`;
    await createConversationMessage(conversation.id, 'ai', errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return { message: null, errorMessage: errorText, conversationUpdated: true };
  }

  const itemSummaries = items.map((item) => {
    const price = item.menu_item_price[0];
    const priceText = price
      ? `${price.amount.toFixed(2)} ${price.currency_code}`
      : 'N/A';
    return {
      title: truncateTitle(item.name),
      payload: `ADD_ITEM:${item.id}:1`,
      description: truncateDescription(priceText),
      sectionTitle: 'Platillos',
    };
  });

  const pages = buildProductListPagesForTag(itemSummaries, tag);
  const totalPages = pages.length;
  const safePage = Math.min(Math.max(page, 1), totalPages || 1);
  const currentPage = pages[safePage - 1];

  const label = TAG_LIST_LABEL[tag];
  const text = `Estos son los platillos de *${label}*. Seleccioná uno para continuar.`;

  const listMessage: WhatsAppListMessage = {
    type: 'list',
    header: {
      type: 'text',
      text: `🤖\n\n*${label}* 🔎`,
    },
    body: { text },
    footer: {
      text:
        totalPages > 1 ? `Página ${safePage} de ${totalPages}` : 'Elegí un platillo',
    },
    action: {
      button: 'Ver platillos',
      sections: [
        {
          title: 'Platillos',
          rows: (currentPage?.buttons ?? []).map((btn) => ({
            id: btn.payload,
            title: btn.title,
            description: btn.description || 'Seleccionar',
          })),
        },
      ],
    },
  };

  await createConversationMessage(conversation.id, 'ai', text, false);
  await updateConversationLastMessageAt(conversation.id);

  return { message: listMessage, conversationUpdated: true };
};

export const buildCategoryProductListMessage = async (
    business: BusinessType,
    conversation: ConversationType,
    categoryId: string,
    page = 1
): Promise<CategoryMessageResult> => {

    const category = await prisma.menu_category.findFirst({
        where: { id: categoryId, business_id: business.id, is_active: true },
        select: { id: true, name: true }
    });

    if (!category) {
        const errorText = 'Categoría no encontrada';
        await createConversationMessage(conversation.id, 'ai', errorText, false);
        await updateConversationLastMessageAt(conversation.id);
        return { message: null, errorMessage: errorText, conversationUpdated: true };
    }

    const businessCurrency = await prisma.business.findUnique({
        where: { id: business.id },
        select: { currency_code: true }
    });

    const currency = businessCurrency?.currency_code;
    const now = new Date();
    const priceWhere = {
        currency_code: currency ?? undefined,
        is_active: true,
        valid_from: { lte: now },
        OR: [{ valid_to: null }, { valid_to: { gte: now } }]
    };

    const items = await prisma.menu_item.findMany({
        where: {
            business_id: business.id,
            category_id: categoryId,
            is_available: true,
            menu_item_price: {
                some: priceWhere
            }
        },
        orderBy: { created_at: 'asc' },
        include: {
            menu_item_price: {
                where: priceWhere,
                orderBy: { valid_from: 'desc' },
                take: 1
            }
        }
    });

    if (items.length === 0) {
        const errorText = 'No hay platillos disponibles en esta categoría.';
        await createConversationMessage(conversation.id, 'ai', errorText, false);
        await updateConversationLastMessageAt(conversation.id);
        return { message: null, errorMessage: errorText, conversationUpdated: true };
    }

    const itemSummaries = items.map((item) => {
        const price = item.menu_item_price[0];
        const priceText = price
            ? `${price.amount.toFixed(2)} ${price.currency_code}`
            : 'N/A';
        return {
            title: truncateTitle(item.name),
            payload: `ADD_ITEM:${item.id}:1`,
            description: truncateDescription(priceText),
            sectionTitle: 'Platillos'
        };
    });

    const pages = buildProductListPages(itemSummaries, categoryId);
    const totalPages = pages.length;
    const safePage = Math.min(Math.max(page, 1), totalPages || 1);
    const currentPage = pages[safePage - 1];

    const text = `Excelente eleccion! Estos son los platillos de ${category.name}. Selecciona uno para continuar.`;

    // Construir WhatsAppListMessage (NO enviar)
    const listMessage: WhatsAppListMessage = {
        type: 'list',
        header: {
            type: 'text',
            text: `🤖\n\n*${category.name}* 🔎`
        },
        body: { text },
        footer: {
            text: totalPages > 1 ? `Página ${safePage} de ${totalPages}` : 'Elige un platillo'
        },
        action: {
            button: 'Ver platillos',
            sections: [{
                title: 'Platillos',
                rows: (currentPage?.buttons ?? []).map(btn => ({
                    id: btn.payload,
                    title: btn.title,
                    description: btn.description || 'Seleccionar'
                }))
            }]
        }
    };

    await createConversationMessage(conversation.id, 'ai', text, false);
    await updateConversationLastMessageAt(conversation.id);

    return { message: listMessage, conversationUpdated: true };
};

/**
 * Cuerpo del listado de categorías: atajos (nombres) primero,
 * lista WA como alternativa. También invita a escribir un plato.
 */
export function buildViewCategoriesBodyText(categoryNames: string[]): string {
  const bullets = categoryNames
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => shortcutBullet(name));

  return buildShortcutsThenListBody(
    'Escribí una categoría o el nombre del plato que querés:',
    bullets
  );
}

export const buildViewCategoriesMessage = async (
    business: BusinessType,
    conversation: ConversationType,
    page = 1,
    isFromMenuReturn = false
  ): Promise<ViewCategoriesResult> => {
  
    const MAX_ROWS = 10;
  
    const categories = await prisma.menu_category.findMany({
      where: { business_id: business.id, is_active: true },
      orderBy: { name: 'asc' },
      skip: (page - 1) * MAX_ROWS,
      take: MAX_ROWS + 1 // 10 + 1 para detectar si hay más
    });
  
    if (categories.length === 0) {
      const errorText = 'No hay categorías disponibles.';
      await createConversationMessage(conversation.id, 'ai', errorText, false);
      await updateConversationLastMessageAt(conversation.id);
      return { message: null, errorMessage: errorText };
    }
  
    const hasMore = categories.length > MAX_ROWS;
  
    // 👇 calcular slots especiales
    const specialSlots =
      (isFromMenuReturn ? 1 : 0) +
      (hasMore ? 1 : 0);
  
    const maxCategorySlots = MAX_ROWS - specialSlots;
  
    const displayCategories = categories.slice(0, maxCategorySlots);
  
    const rows = [];
  
    if (isFromMenuReturn) {
      rows.push({
        id: 'VIEW_MENU_RETURN',
        title: '⬅️ Menú principal',
        description: 'Volver al inicio'
      });
    }
  
    rows.push(
      ...displayCategories.map(cat => ({
        id: `CATEGORY:${cat.id}`,
        title: truncateTitle(cat.name),
        description: 'Ver platillos'
      }))
    );
  
    if (hasMore) {
      rows.push({
        id: `CATEGORY_LIST_PAGE:${page + 1}`,
        title: 'Más categorías →',
        description: 'Siguiente página'
      });
    }

    const bodyPlain = buildViewCategoriesBodyText(
      displayCategories.map((cat) => cat.name)
    );
  
    const listMessage: WhatsAppListMessage = {
      type: 'list',
      header: { type: 'text', text: '🤖\n\n*Este es nuestro menú* 🍲' },
      body: {
        text: bodyPlain,
      },
      footer: { text: hasMore ? `Página ${page}` : 'Elegí o escribí' },
      action: {
        button: 'Ver categorías',
        sections: [{ title: 'Categorías disponibles', rows }]
      }
    };
  
    await createConversationMessage(conversation.id, 'ai', listMessage.body.text, false);
    await updateConversationLastMessageAt(conversation.id);
  
    return { message: listMessage };
  };

export const handleViewCategories = async (
    payload: WhatsAppWebhookPayload,
    page = 1,
    isFromMenuReturn = false
): Promise<WhatsAppListMessage | string | null> => {

    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const from = message?.from;
    const phoneNumberId = value?.metadata?.phone_number_id;

    if (!phoneNumberId || !from) return null;

    const business = await findBusinessByPhoneNumberId(phoneNumberId);
    if (!business) return null;

    const customer = await findOrCreateCustomer(business.id, from);
    const conversation = await createOrGetOpenConversation(business.id, customer.id);
    await findOrCreateConversationState(conversation.id);

    console.log('DEBUG handleViewCategories payload:', payload);
    console.log('DEBUG handleViewCategories page:', page);
    console.log('DEBUG handleViewCategories isFromMenuReturn:', isFromMenuReturn);
    console.log('DEBUG handleViewCategories business:', business);
    console.log('DEBUG handleViewCategories customer:', customer);
    console.log('DEBUG handleViewCategories conversation:', conversation);

    const result = await buildViewCategoriesMessage(business, conversation, page, isFromMenuReturn);

    if (result.errorMessage) return result.errorMessage;
    return result.message;
};

export const handleViewMenuReturnFromWebhook = async (
    payload: WhatsAppWebhookPayload
): Promise<WhatsAppListMessage | string | null> => {

    // Es un alias de viewCategories con page=1 y isFromMenuReturn=true
    return handleViewCategories(payload, 1, true);
};

export const handleViewMenuFromWebhook = async (
    payload: WhatsAppWebhookPayload
): Promise<WhatsAppListMessage | string | null> => {

    // Es un alias de viewCategories con page=1 y isFromMenuReturn=true
    return handleViewCategories(payload, 1, true);
};

export const handleCategoryPageFromWebhook = async (
    payload: WhatsAppWebhookPayload,
    categoryId: string,
    page: number
): Promise<WhatsAppListMessage | string | null> => {

    // Reutiliza buildCategoryMessage con la página específica
    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const from = message?.from;
    const phoneNumberId = value?.metadata?.phone_number_id;

    if (!phoneNumberId || !from || !categoryId) return null;

    const business = await findBusinessByPhoneNumberId(phoneNumberId);
    if (!business) return null;

    const customer = await findOrCreateCustomer(business.id, from);
    const conversation = await createOrGetOpenConversation(business.id, customer.id);
    await findOrCreateConversationState(conversation.id);

    const result = await buildCategoryProductListMessage(business, conversation, categoryId, page);

    if (result.errorMessage) return result.errorMessage;
    return result.message;
};

export const handleCategoryListPageFromWebhook = async (
    payload: WhatsAppWebhookPayload,
    page: number
): Promise<WhatsAppListMessage | string | null> => {

    // Reutiliza buildViewCategoriesMessage con isFromMenuReturn=true
    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const from = message?.from;
    const phoneNumberId = value?.metadata?.phone_number_id;

    if (!phoneNumberId || !from) return null;

    const business = await findBusinessByPhoneNumberId(phoneNumberId);
    if (!business) return null;

    const customer = await findOrCreateCustomer(business.id, from);
    const conversation = await createOrGetOpenConversation(business.id, customer.id);
    await findOrCreateConversationState(conversation.id);

    const result = await buildViewCategoriesMessage(business, conversation, page, true);

    if (result.errorMessage) return result.errorMessage;
    return result.message;
};

// Agregar al final de categoryService.ts

export const handleCategorySelectionFromWebhook = async (
    payload: WhatsAppWebhookPayload,
    categoryId: string,
    page = 1
  ): Promise<WhatsAppListMessage | string | null> => {
    
    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const from = message?.from;
    const phoneNumberId = value?.metadata?.phone_number_id;
  
    if (!phoneNumberId || !from || !categoryId) return null;
  
    const business = await findBusinessByPhoneNumberId(phoneNumberId);
    if (!business) return null;
  
    const customer = await findOrCreateCustomer(business.id, from);
    const conversation = await createOrGetOpenConversation(business.id, customer.id);
    await findOrCreateConversationState(conversation.id);
  
    const result = await buildCategoryProductListMessage(business, conversation, categoryId, page);
    
    if (result.errorMessage) return result.errorMessage;
    return result.message;
  };

export const handleMenuByTagSelectionFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  tag: MenuCategoryTag,
  page = 1
): Promise<WhatsAppListMessage | string | null> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  await findOrCreateConversationState(conversation.id);

  const result = await buildMenuListByCategoryTagMessage(
    business,
    conversation,
    tag,
    page
  );

  if (result.errorMessage) return result.errorMessage;
  return result.message;
};