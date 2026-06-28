import {
  SendMessageRequest,
  WhatsAppWebhookPayload
} from '../types/whatsapp';
import {
  createOrGetOpenConversation,
  createConversationMessage,
  closeConversation,
  findBusinessByPhoneNumberId,
  findBusinessById,
  findByWhatsappMessageId,
  getRecentMessagesByConversationId,
  findOrCreateConversationState,
  updateConversationState,
  findOrCreateCustomer,
  findCustomerById,
  updateConversationLastMessageAt
} from '../repositories';
import type { OpenAI as OpenAITypes } from 'openai';
import {
  generateAIResponse,
  generateFilteredSetResponse,
  generateOrderActionAnalysis,
  generateOrderExtraction,
  generateOrderResolution,
  generateProductAwareResponse
} from './ai/openai.service';
import { detectIntentWithConfidence } from './conversationOrchestrator.service';
import { MenuItemSearchResult, MenuService } from './menu.service';
import { ConversationIntent } from '../types/conversationIntent';
import { WhatsAppSenderService } from './whatsappSender.service';
import { OrderPaymentStatus, OrderStatus, Prisma } from '@prisma/client';
import { computeCartTotalDecimal, computeOrderPricing } from './pricing.service';
import { resolveEffectivePrice } from '../helpers/menuItemPrice.helper';
import type { ConfirmationState } from '../domain/intent/types';
import type { WhatsAppInteractiveMessage, WhatsAppListMessage } from '../domain/intent/whatsappTemplates';
import { INTENT_SELECTION_ID_PREFIX } from '../domain/intent/whatsappTemplates';
import type {
  business as Business,
  conversation as Conversation,
  customer as Customer
} from '@prisma/client';
import { prisma } from '../lib/prisma';
import { emitAdminOrderCreated } from '../socket/adminSocket';
import {
  clearProductFilterMetadata,
  formatBotUserMessage,
  getRequestedPartySize,
  parseSelectProductListRowId,
  partySizeMetadataFields,
  withoutLegacyPartyQuantity,
} from './productQuery/utils';

const confirmationStates = new Map<string, ConfirmationState>();
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const CONFIRMATION_CLEANUP_MS = 10 * 60 * 1000;
const LIST_CONFIRMATION_REGEX = new RegExp(`^${INTENT_SELECTION_ID_PREFIX}([A-Z_]+)$`);

setInterval(() => {
  const now = new Date();
  for (const [phone, state] of confirmationStates.entries()) {
    if (state.status === 'awaiting_confirmation' && now > state.expiresAt) {
      confirmationStates.delete(phone);
    }
  }
}, CONFIRMATION_CLEANUP_MS);

const isListConfirmation = (
  messageText: string
): { isConfirmation: boolean; intent?: ConversationIntent } => {
  const match = messageText.match(LIST_CONFIRMATION_REGEX);
  if (match) {
    const intent = match[1] as ConversationIntent;
    if (Object.values(ConversationIntent).includes(intent)) {
      return { isConfirmation: true, intent };
    }
  }
  return { isConfirmation: false };
};

const chunkButtons = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const toRowTitle = (value: string, maxLength = 24): string => value.slice(0, maxLength);
const toRowDescription = (value: string, maxLength = 72): string => value.slice(0, maxLength);


export const buildCategoryListPages = (
  buttons: { title: string; payload: string; description?: string; sectionTitle?: string }[],
  pageSize = 10
): { buttons: typeof buttons; page: number; totalPages: number }[] => {
  const itemsPerPage = Math.max(pageSize - 2, 1);
  const totalPages = Math.ceil(buttons.length / itemsPerPage);
  const pages: { buttons: typeof buttons; page: number; totalPages: number }[] = [];

  for (let page = 1; page <= totalPages; page += 1) {
    const start = (page - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const pageButtons = buttons.slice(start, end);
    const prevPage = page - 1;
    const nextPage = page + 1;

    if (prevPage >= 1) {
      pageButtons.push({
        title: 'Pagina anterior',
        payload: `CATEGORY_LIST_PAGE:${prevPage}`,
        description: 'Regresar a la pagina anterior',
        sectionTitle: 'Categorías'
      });
    }

    if (nextPage <= totalPages) {
      const nextStart = (nextPage - 1) * itemsPerPage;
      const nextEnd = nextStart + itemsPerPage;
      const nextTitles = buttons
        .slice(nextStart, nextEnd)
        .map((button) => button.title)
        .join(', ');

      pageButtons.push({
        title: 'Ver mas categorias',
        payload: `CATEGORY_LIST_PAGE:${nextPage}`,
        description: toRowDescription(nextTitles),
        sectionTitle: 'Categorías'
      });
    }

    pages.push({ buttons: pageButtons, page, totalPages });
  }

  return pages;
};

export const buildProductListPages = (
  items: { title: string; payload: string; description?: string; sectionTitle?: string }[],
  categoryId: string,
  pageSize = 10
): { buttons: typeof items; page: number; totalPages: number }[] => {
  const itemsPerPage = Math.max(pageSize - 3, 1);
  const totalPages = Math.ceil(items.length / itemsPerPage);
  const pages: { buttons: typeof items; page: number; totalPages: number }[] = [];

  for (let page = 1; page <= totalPages; page += 1) {
    const start = (page - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const pageButtons = items.slice(start, end);
    const prevPage = page - 1;
    const nextPage = page + 1;

    if (prevPage >= 1) {
      pageButtons.push({
        title: 'Pagina anterior',
        payload: `CATEGORY_PAGE:${categoryId}:${prevPage}`,
        description: 'Regresar a la pagina anterior',
        sectionTitle: 'Platillos'
      });
    }

    if (nextPage <= totalPages) {
      const nextStart = (nextPage - 1) * itemsPerPage;
      const nextEnd = nextStart + itemsPerPage;
      const nextTitles = items
        .slice(nextStart, nextEnd)
        .map((item) => item.title)
        .join(', ');

      pageButtons.push({
        title: 'Ver mas platillos',
        payload: `CATEGORY_PAGE:${categoryId}:${nextPage}`,
        description: toRowDescription(nextTitles),
        sectionTitle: 'Platillos'
      });
    }

    pageButtons.push({
      title: 'Volver a categorias',
      payload: 'VIEW_MENU_RETURN',
      description: 'Elegir otra categoria',
      sectionTitle: 'Platillos'
    });

    pages.push({ buttons: pageButtons, page, totalPages });
  }

  return pages;
};

export const handleViewMenuIntent = async (
  businessId: string,
  customerId: string,
  conversationId: string
): Promise<void> => {
  const [business, customer, menuResponse] = await Promise.all([
    findBusinessById(businessId),
    findCustomerById(customerId),
    MenuService.getMenuForCustomer({ businessId, customerId })
  ]);

  if (!business) {
    throw new Error('Business no encontrado');
  }
  if (!customer) {
    throw new Error('Customer no encontrado');
  }
  if (!business.whatsapp_phone_id) {
    throw new Error('Business sin whatsapp_phone_id');
  }

  await createConversationMessage(conversationId, 'ai', menuResponse.text, true);
  await updateConversationLastMessageAt(conversationId);

  const sender = new WhatsAppSenderService();
  if (menuResponse.buttons.length === 0) {
    await sender.sendTextMessage({
      phoneNumberId: business.whatsapp_phone_id,
      to: customer.phone_number,
      message: menuResponse.text
    });
    return;
  }

  await sender.sendInteractiveMenu({
    phoneNumberId: business.whatsapp_phone_id,
    to: customer.phone_number,
    text: menuResponse.text,
    buttons: menuResponse.buttons
  });
  await updateConversationState(conversationId, { current_intent: 'greeted' });
};

export const handleViewCategoriesFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  page = 1,
  isReturn = false
): Promise<void> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from) {
    return;
  }

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    return;
  }

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  const conversationState = await findOrCreateConversationState(conversation.id);
  const currentMetadata = normalizeMetadata(conversationState.metadata);
  const clearedMetadata = clearPendingSelection(currentMetadata);
  if (clearedMetadata !== currentMetadata) {
    await updateConversationState(conversation.id, {
      metadata: buildMetadataValue(clearedMetadata)
    });
  }
  await handleViewCategories(
    business.id,
    customer.id,
    conversation.id,
    from,
    phoneNumberId,
    page,
    isReturn
  );
  await updateConversationState(conversation.id, { current_intent: 'greeted' });
};

const handleViewCategories = async (
  businessId: string,
  customerId: string,
  conversationId: string,
  to: string,
  phoneNumberId: string,
  page = 1,
  isReturn = false
): Promise<void> => {
  const menuResponse = await MenuService.getCategoryListForCustomer({
    businessId,
    customerId
  });

  const sender = new WhatsAppSenderService();

  if (menuResponse.buttons.length === 0) {
    await sender.sendTextMessage({
      phoneNumberId,
      to,
      message: menuResponse.text
    });
    await createConversationMessage(conversationId, 'ai', menuResponse.text, true);
    await updateConversationLastMessageAt(conversationId);
    return;
  }

  const pages = buildCategoryListPages(menuResponse.buttons);
  const totalPages = pages.length;
  const safePage = Math.min(Math.max(page, 1), totalPages || 1);
  const currentPage = pages[safePage - 1];
  let pageText = `📋 Categorías (pagina ${safePage} de ${totalPages})\n\nSelecciona una categoría o usa las opciones para navegar.`;
  if (safePage === 1 && !isReturn) {
    const menuHeader = await MenuService.getMenuForCustomer({
      businessId,
      customerId
    });
    pageText = menuHeader.text;
  }

  await sender.sendInteractiveMenu({
    phoneNumberId,
    to,
    text: pageText,
    buttons: currentPage?.buttons ?? [],
    forceList: true,
    actionButtonLabel: 'Elige categoria',
    page: totalPages > 1 ? safePage : undefined,
    totalPages: totalPages > 1 ? totalPages : undefined
  });

  await createConversationMessage(conversationId, 'ai', menuResponse.text, true);
  await updateConversationLastMessageAt(conversationId);
};

export const handleCategorySelectionFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  categoryId: string,
  page = 1
): Promise<void> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !categoryId) {
    return;
  }

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    return;
  }

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  const conversationState = await findOrCreateConversationState(conversation.id);
  await handleCategorySelection(business, conversation, categoryId, from, phoneNumberId, page);
};

/** True si el cliente pidió ≥2 personas y la ficha no indica que alcanza con una unidad. */
function servingDoesNotMeetRequestedPeople(
  requested: number | null | undefined,
  servesPeople: number | null
): boolean {
  if (requested == null || requested < 2) return false;
  if (servesPeople == null || servesPeople < 1) return true;
  return servesPeople < requested;
}

export const handleAddItemFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  menuItemId: string
): Promise<void> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !menuItemId) {
    return;
  }

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    return;
  }

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  const conversationState = await findOrCreateConversationState(conversation.id);
  await handleAddItemToDraftOrder(business, conversation, customer, menuItemId, from, phoneNumberId);
};

export const handleProductSelectionFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  productIdOrListRowId: string
): Promise<WhatsAppInteractiveMessage | null> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !productIdOrListRowId) {
    return null;
  }

  const parsedRow = parseSelectProductListRowId(productIdOrListRowId);
  const productId = parsedRow.productId;
  const listSuggestedQuantity = parsedRow.listSuggestedQuantity;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    return null;
  }

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  const conversationState = await findOrCreateConversationState(conversation.id);
  const metadata = normalizeMetadata(conversationState.metadata);
  console.log('DEBUG selection:', {
    selectedId: productIdOrListRowId,
    cleanProductId: productId,
    listSuggestedQuantity,
    conversationId: conversation.id,
    candidateProductIds: metadata.candidateProductIds,
    match: metadata.candidateProductIds?.includes(productId)
  });

  if (!metadata.pendingProductSelection || !metadata.pendingQuestion) {
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: '' },
        body: {
          text: formatBotUserMessage(
            'Opción expirada',
            '⚠️',
            'Esta opción ya no está disponible. Hacé una nueva consulta o explorá el menú.'
          ),
        },
        footer: { text: 'Elegí una opción' },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'VIEW_MENU',
                title: 'Ver menú',
              },
            },
          ],
        },
      },
    };

  }

  if (!metadata.candidateProductIds?.includes(productId)) {
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: '' },
        body: {
          text: formatBotUserMessage(
            'Opción expirada',
            '⚠️',
            'Esta opción ya no está disponible. Hacé una nueva consulta o explorá el menú.'
          ),
        },
        footer: { text: 'Elegí una opción' },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'VIEW_MENU',
                title: 'Ver menú',
              },
            },
          ],
        },
      },
    };
  }

  const item = await prisma.menu_item.findUnique({
    where: { id: productId },
    select: {
      id: true,
      name: true,
      description: true,
      ingredients: true,
      serves_people: true,
      is_available: true,
      image: true
    }
  });

  if (!item) {
    return null;
  }

  if (!item.is_available) {
    const messageText = `El producto "${item.name}" no está disponible en este momento.`;
    await createConversationMessage(conversation.id, 'ai', messageText, false);
    await updateConversationLastMessageAt(conversation.id);
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastReferencedProductId: item.id }
    });
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: 'Platillo no disponible' },
        body: { text: messageText },
        footer: { text: 'Elige una opción' },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'VIEW_MENU',
                title: 'Ver menú',
              }
            }
          ]
        }
      }
    };
  }

  const currency = customer.preferred_currency ?? business.currency_code ?? null;
  const now = new Date();
  const priceWhere = {
    is_active: true,
    valid_from: { lte: now },
    OR: [{ valid_to: null }, { valid_to: { gte: now } }],
    ...(currency ? { currency_code: currency } : {})
  };

  const activePrice = await prisma.menu_item_price.findFirst({
    where: {
      menu_item_id: item.id,
      ...priceWhere
    },
    orderBy: { valid_from: 'desc' }
  });

  if (!activePrice) {
    const messageText = `No tengo el precio actual de "${item.name}".`;
    await createConversationMessage(conversation.id, 'ai', messageText, false);
    await updateConversationLastMessageAt(conversation.id);
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastReferencedProductId: item.id }
    });

    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        header: { type: 'text', text: 'Precio no disponible' },
        body: { text: messageText },
        footer: { text: 'Elige una opción' },
        action: {
          buttons: [
            {
              type: 'reply',
              reply: {
                id: 'VIEW_MENU',
                title: 'Ver menú',
              }
            }
          ]
        }
      }
    };
  }

  console.log('---- PRODUCT SELECTED ----');
  console.log('Selected product ID:', productId);
  console.log('Selected product name:', item.name);
  console.log('Stored pendingQuestion:', metadata.pendingQuestion);
  console.log('--------------------------------');

  const requestedQty = getRequestedPartySize(metadata);
  const servesMismatch = servingDoesNotMeetRequestedPeople(
    requestedQty,
    item.serves_people
  );

  let quantityContext = '';
  if (requestedQty != null && requestedQty > 0) {
    const servesLabel =
      item.serves_people != null && item.serves_people > 0
        ? `${item.serves_people} persona(s) por porción según la ficha`
        : 'no indicado en la ficha cuántas personas alcanza una porción';
    quantityContext = `\n\nCONTEXTO DE PORCIONES:\n- El cliente buscaba algo para aproximadamente ${requestedQty} persona(s).\n- En los datos del plato: sirve a = ${servesLabel}.\n${
      servesMismatch
        ? '- Es importante: aclarar en tu respuesta que una sola unidad puede no alcanzar para todos y que puede sumar varias unidades con los botones (hay uno para agregar varias de una vez). Sé concreto y no inventes números que no estén en la ficha.'
        : '- Si la ficha alcanza para lo pedido, podés confirmarlo brevemente.'
    }`;
  }

  const aiResponse = await generateProductAwareResponse({
    businessId: business.id,
    product: {
      name: item.name,
      description: item.description,
      ingredients: item.ingredients,
      serves_people: item.serves_people,
      is_available: item.is_available,
      price: {
        amount: activePrice.amount,
        currency_code: activePrice.currency_code
      }
    },
    userQuestion: `El usuario originalmente preguntó: "${metadata.pendingQuestion}".
El usuario seleccionó el producto "${item.name}".
Respondé en español con información útil sobre el plato (precio, porciones si constan, etc.).${quantityContext}`,
    requestedPartySize: requestedQty
  });

  await createConversationMessage(conversation.id, 'ai', aiResponse, true);
  await updateConversationLastMessageAt(conversation.id);
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastReferencedProductId: item.id }
  });
  const cleanedMetadata = clearProductFilterMetadata(metadata);
  const {
    lastListSuggestedQuantity: _dropPrevSuggested,
    ...metaWithoutPrevSuggested
  } = cleanedMetadata as ConversationMetadata;
  void _dropPrevSuggested;
  const nextProductFocusMeta: ConversationMetadata = {
    ...metaWithoutPrevSuggested,
    ...(listSuggestedQuantity != null
      ? { lastListSuggestedQuantity: listSuggestedQuantity }
      : {}),
  };
  console.debug('Conversation mode:', 'PRODUCT_FOCUS');
  await updateConversationState(conversation.id, {
    mode: 'PRODUCT_FOCUS',
    metadata: buildMetadataValue(nextProductFocusMeta)
  } as Prisma.conversation_stateUpdateInput & { mode?: ConversationMode });
  const header = item.image
    ? ({ type: 'image', image: { link: item.image } } as const)
    : ({ type: 'text', text: 'Tenemos un match para tu consulta' } as const);

  /** WhatsApp permite máximo 3 botones de respuesta (error 131009 si se excede). */
  const MAX_REPLY_BUTTONS = 3;

  const extraAddQuantities = new Set<number>();
  if (listSuggestedQuantity != null && listSuggestedQuantity > 1) {
    extraAddQuantities.add(listSuggestedQuantity);
  }
  if (servesMismatch && requestedQty != null && requestedQty >= 2) {
    extraAddQuantities.add(requestedQty);
  }

  const buttons: Array<{
    type: 'reply';
    reply: { id: string; title: string };
  }> = [
    {
      type: 'reply',
      reply: { id: `ADD_ITEM:${item.id}:1`, title: 'Agregar 1' },
    },
  ];

  for (const q of Array.from(extraAddQuantities).sort((a, b) => a - b)) {
    if (q === 1) continue;
    if (buttons.length >= MAX_REPLY_BUTTONS) break;
    buttons.push({
      type: 'reply',
      reply: {
        id: `ADD_ITEM:${item.id}:${q}`,
        title: `Agregar ${q}`,
      },
    });
  }

  if (buttons.length < MAX_REPLY_BUTTONS) {
    buttons.push({
      type: 'reply',
      reply: { id: 'VIEW_MENU', title: 'Ver menú' },
    });
  }

  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header,
      body: { text: `🤖\n\n${aiResponse}` },
      footer: { text: 'Elegí una opción' },
      action: { buttons },
    },
  };
};

export const handleOrderProductSelectionFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  productId: string
): Promise<string | WhatsAppListMessage> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !productId) {
    return '';
  }

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    return '';
  }

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  const conversationState = await findOrCreateConversationState(conversation.id);
  const metadata = normalizeMetadata(conversationState.metadata);

  console.log('DEBUG metadata:', metadata);

  if (!metadata.pendingOrderSelection || !metadata.pendingOrderMessage) {
    console.log('DEBUG metadata.pendingOrderSelection:', metadata.pendingOrderSelection);
    console.log('DEBUG metadata.pendingOrderMessage:', metadata.pendingOrderMessage);
    return 'Esa opción ya no está disponible. Por favor realiza una nueva consulta.';
  }

  if (!metadata.pendingOrderCandidateIds?.includes(productId)) {
    console.log('DEBUG metadata.pendingOrderCandidateIds:', metadata.pendingOrderCandidateIds);
    console.log('DEBUG productId:', productId);
    return 'Esa opción ya no está disponible. Por favor realiza una nueva consulta.';
  }

  const item = await prisma.menu_item.findUnique({
    where: { id: productId },
    select: { id: true, name: true, is_available: true, image: true }
  });

  if (!item) {
    return '';
  }

  if (!item.is_available) {
    const messageText = `El producto "${item.name}" no está disponible en este momento.`;
    await createConversationMessage(conversation.id, 'ai', messageText, false);
    await updateConversationLastMessageAt(conversation.id);
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastReferencedProductId: item.id }
    });
    await updateConversationState(conversation.id, { metadata: Prisma.JsonNull });
    return messageText;
  }

  console.log('---- ORDER FOOD ----');
  console.log('Using product:', item.id);
  console.log('User message:', metadata.pendingOrderMessage);
  console.log('---------------------');

  const extraction = await generateOrderExtraction({
    userMessage: metadata.pendingOrderMessage
  });
  const quantity =
    Number.isFinite(extraction.quantity) && extraction.quantity > 0
      ? Math.round(extraction.quantity)
      : 1;

  try {
    await addProductToOrder({
      conversationId: conversation.id,
      productId: item.id,
      quantity
    });
  } catch (error) {
    const messageText =
      error instanceof Error
        ? `No pude agregar el producto: ${error.message}`
        : 'No pude agregar el producto en este momento.';
    await createConversationMessage(conversation.id, 'ai', messageText, false);
    await updateConversationLastMessageAt(conversation.id);
    await updateConversationState(conversation.id, { metadata: Prisma.JsonNull });
    return messageText;
  }

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastReferencedProductId: item.id }
  });
  await updateConversationState(conversation.id, { metadata: Prisma.JsonNull });

  const messageText = `Perfecto ✅ Agregué ${quantity} ${item.name} a tu pedido. ¿Deseas algo más?`;
  await createConversationMessage(conversation.id, 'ai', messageText, false);
  await updateConversationLastMessageAt(conversation.id);
  return messageText;
};

export const handleOrderSearchPageFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  page: number
): Promise<string | WhatsAppListMessage> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from) {
    return '';
  }

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    return '';
  }

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  const conversationState = await findOrCreateConversationState(conversation.id);
  const metadata = normalizeMetadata(conversationState.metadata);

  if (!metadata.pendingOrderSelection || !metadata.pendingOrderCandidateIds?.length) {
    return 'Esa opción ya no está disponible. Por favor realiza una nueva consulta.';
  }

  const items = await prisma.menu_item.findMany({
    where: { id: { in: metadata.pendingOrderCandidateIds } },
    select: { id: true, name: true, description: true, ingredients: true }
  });
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const orderedItems = metadata.pendingOrderCandidateIds
    .map((id) => itemMap.get(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const listMessage = buildOrderSearchListMessage({
    items: orderedItems,
    page
  });
  await createConversationMessage(conversation.id, 'ai', listMessage.body.text, false);
  await updateConversationLastMessageAt(conversation.id);
  return listMessage;
};

export const handleCheckoutFromWebhook = async (
  payload: WhatsAppWebhookPayload
): Promise<void> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from) {
    return;
  }

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    return;
  }

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  const conversationState = await findOrCreateConversationState(conversation.id);
  await handleCheckout(business, conversation, customer, from, phoneNumberId);
};

export const handleAskQuestionFromWebhook = async (
  payload: WhatsAppWebhookPayload
): Promise<void> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from) {
    return;
  }

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    return;
  }

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  const conversationState = await findOrCreateConversationState(conversation.id);

  const sender = new WhatsAppSenderService();
  const messageText =
    'Claro, estoy aqui para ayudarte. Escribe tu duda con total confianza y la reviso enseguida.';

  await sender.sendTextMessage({
    phoneNumberId,
    to: from,
    message: messageText
  });

  await createConversationMessage(conversation.id, 'ai', messageText, false);
  await updateConversationState(conversation.id, { current_intent: 'greeted' });
  await updateConversationLastMessageAt(conversation.id);
};

const sendAskQuestionPrompt = async (
  conversationId: string,
  to: string,
  phoneNumberId: string
): Promise<void> => {
  const sender = new WhatsAppSenderService();
  const messageText =
    'Claro, estoy aqui para ayudarte. Escribe tu duda con total confianza y la reviso enseguida.';

  await sender.sendTextMessage({
    phoneNumberId,
    to,
    message: messageText
  });

  await createConversationMessage(conversationId, 'ai', messageText, false);
  await updateConversationLastMessageAt(conversationId);
  await updateConversationState(conversationId, { current_intent: 'greeted' });
};

export const handleCancelOrderFromWebhook = async (
  payload: WhatsAppWebhookPayload
): Promise<void> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from) {
    return;
  }

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    return;
  }

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  await findOrCreateConversationState(conversation.id);
  await handleCancelOrder(business, conversation, customer, from, phoneNumberId);
};

export const handleEndConversationFromWebhook = async (
  payload: WhatsAppWebhookPayload
): Promise<void> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from) {
    return;
  }

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    return;
  }

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  await findOrCreateConversationState(conversation.id);
  await handleEndConversation(conversation, from, phoneNumberId);
};

export const handleCategorySelection = async (
  business: Business,
  conversation: Conversation,
  categoryId: string,
  to: string,
  phoneNumberId: string,
  page = 1
): Promise<void> => {
  const category = await prisma.menu_category.findFirst({
    where: { id: categoryId, business_id: business.id, is_active: true },
    select: { id: true, name: true }
  });

  if (!category) {
    const sender = new WhatsAppSenderService();
    await sender.sendTextMessage({
      phoneNumberId,
      to,
      message: 'Categoría no encontrada'
    });
    await createConversationMessage(conversation.id, 'ai', 'Categoría no encontrada', false);
    await updateConversationLastMessageAt(conversation.id);
    return;
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
    const sender = new WhatsAppSenderService();
    await sender.sendTextMessage({
      phoneNumberId,
      to,
      message: 'No hay platillos disponibles en esta categoría.'
    });
    await createConversationMessage(
      conversation.id,
      'ai',
      'No hay platillos disponibles en esta categoría.',
      false
    );
    await updateConversationLastMessageAt(conversation.id);
    return;
  }

  const sender = new WhatsAppSenderService();
  const itemSummaries = items.map((item) => {
    const price = item.menu_item_price[0];
    const priceText = price
      ? `${price.amount.toFixed(2)} ${price.currency_code}`
      : 'N/A';
    return {
      title: toRowTitle(item.name),
      payload: `ADD_ITEM:${item.id}:1`,
      description: toRowDescription(priceText),
      sectionTitle: 'Platillos'
    };
  });

  const pages = buildProductListPages(itemSummaries, categoryId);
  const totalPages = pages.length;
  const safePage = Math.min(Math.max(page, 1), totalPages || 1);
  const currentPage = pages[safePage - 1];
  const text =
    totalPages > 1
      ? `Excelente eleccion! Estos son los platillos de ${category.name}. Selecciona uno para continuar.`
      : `Excelente eleccion! Estos son los platillos de ${category.name}. Selecciona uno para continuar.`;

  await sender.sendInteractiveMenu({
    phoneNumberId,
    to,
    text,
    buttons: currentPage?.buttons ?? [],
    forceList: true,
    actionButtonLabel: 'Ver platillos',
    page: totalPages > 1 ? safePage : undefined,
    totalPages: totalPages > 1 ? totalPages : undefined
  });

  await createConversationMessage(conversation.id, 'ai', text, false);

  await updateConversationLastMessageAt(conversation.id);
};

export const handleAddItemToDraftOrder = async (
  business: Business,
  conversation: Conversation,
  customer: Customer,
  menuItemId: string,
  to: string,
  phoneNumberId: string
): Promise<void> => {
  const businessCurrency = await prisma.business.findUnique({
    where: { id: business.id },
    select: { currency_code: true }
  });
  const currency = businessCurrency?.currency_code ?? customer.preferred_currency;
  if (!currency) {
    const sender = new WhatsAppSenderService();
    await sender.sendTextMessage({
      phoneNumberId,
      to,
      message: 'No tengo tu moneda preferida registrada para procesar el pedido.'
    });
    await createConversationMessage(
      conversation.id,
      'ai',
      'No tengo tu moneda preferida registrada para procesar el pedido.',
      false
    );
    await updateConversationLastMessageAt(conversation.id);
    return;
  }

  const now = new Date();
  const priceWhere = {
    currency_code: currency,
    is_active: true,
    valid_from: { lte: now },
    OR: [{ valid_to: null }, { valid_to: { gte: now } }]
  };

  const result = await prisma.$transaction(async (tx) => {
    let draftOrder = await tx.draft_order.findFirst({
      where: {
        business_id: business.id,
        customer_phone: customer.phone_number,
        status: 'active'
      }
    });

    if (!draftOrder) {
      draftOrder = await tx.draft_order.create({
        data: {
          business_id: business.id,
          customer_phone: customer.phone_number,
          status: 'active',
          currency
        }
      });
    }

    const existingItem = await tx.draft_order_item.findFirst({
      where: {
        draft_order_id: draftOrder.id,
        product_id: menuItemId
      }
    });

    const menuItemFull = await tx.menu_item.findUnique({
      where: { id: menuItemId },
      select: {
        name: true,
        discount_type: true,
        discount_value: true,
        menu_item_price: {
          where: priceWhere,
          orderBy: { valid_from: 'desc' as const },
          take: 1,
          select: { amount: true }
        }
      }
    });

    if (!menuItemFull) {
      throw new Error('Producto no encontrado');
    }

    const resolved = resolveEffectivePrice(menuItemFull);
    const unitPrice = resolved.finalPrice;
    const itemName = menuItemFull.name ?? '';

    if (existingItem) {
      const newQuantity = existingItem.quantity + 1;
      await tx.draft_order_item.update({
        where: { id: existingItem.id },
        data: {
          quantity: newQuantity,
          unit_price: unitPrice,
          total_price: unitPrice.mul(newQuantity),
          list_price: resolved.hasDiscount ? resolved.listPrice : null,
          discount_amount: resolved.hasDiscount ? resolved.discountAmount : null,
        }
      });
    } else {
      if (!menuItemFull.menu_item_price[0]) {
        throw new Error('Precio no encontrado para el producto');
      }

      await tx.draft_order_item.create({
        data: {
          draft_order_id: draftOrder.id,
          product_id: menuItemId,
          quantity: 1,
          unit_price: unitPrice,
          total_price: unitPrice,
          list_price: resolved.hasDiscount ? resolved.listPrice : null,
          discount_amount: resolved.hasDiscount ? resolved.discountAmount : null,
        }
      });
    }

    const items = await tx.draft_order_item.findMany({
      where: { draft_order_id: draftOrder.id }
    });

    const totalAmount = computeCartTotalDecimal(items);

    const updatedOrder = await tx.draft_order.update({
      where: { id: draftOrder.id },
      data: { total_amount: totalAmount }
    });

    return {
      items,
      total: updatedOrder.total_amount,
      currency
    };
  });

  await sendCurrentOrderSummary(business, conversation, customer, to, phoneNumberId);
};

const addProductToOrder = async (params: {
  conversationId: string;
  productId: string;
  quantity: number;
}): Promise<void> => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    include: {
      business: { select: { currency_code: true, id: true } },
      customer: { select: { preferred_currency: true, phone_number: true } }
    }
  });

  if (!conversation) {
    throw new Error('Conversación no encontrada');
  }

  const currency =
    conversation.customer.preferred_currency ?? conversation.business.currency_code;

  if (!currency) {
    throw new Error('Moneda no disponible para procesar el pedido');
  }

  const now = new Date();
  const priceWhere = {
    currency_code: currency,
    is_active: true,
    valid_from: { lte: now },
    OR: [{ valid_to: null }, { valid_to: { gte: now } }]
  };

  await prisma.$transaction(async (tx) => {
    let draftOrder = await tx.draft_order.findFirst({
      where: {
        business_id: conversation.business.id,
        customer_phone: conversation.customer.phone_number,
        status: 'active'
      }
    });

    if (!draftOrder) {
      draftOrder = await tx.draft_order.create({
        data: {
          business_id: conversation.business.id,
          customer_phone: conversation.customer.phone_number,
          status: 'active',
          currency
        }
      });
    }

    const existingItem = await tx.draft_order_item.findFirst({
      where: {
        draft_order_id: draftOrder.id,
        product_id: params.productId
      }
    });

    const menuItemFull = await tx.menu_item.findUnique({
      where: { id: params.productId },
      select: {
        discount_type: true,
        discount_value: true,
        menu_item_price: {
          where: priceWhere,
          orderBy: { valid_from: 'desc' as const },
          take: 1,
          select: { amount: true }
        }
      }
    });

    if (!menuItemFull?.menu_item_price[0]) {
      throw new Error('Precio no encontrado para el producto');
    }

    const resolved = resolveEffectivePrice(menuItemFull);
    const unitPrice = resolved.finalPrice;

    if (existingItem) {
      const newQuantity = existingItem.quantity + params.quantity;
      await tx.draft_order_item.update({
        where: { id: existingItem.id },
        data: {
          quantity: newQuantity,
          unit_price: unitPrice,
          total_price: unitPrice.mul(newQuantity),
          list_price: resolved.hasDiscount ? resolved.listPrice : null,
          discount_amount: resolved.hasDiscount ? resolved.discountAmount : null,
        }
      });
    } else {
      await tx.draft_order_item.create({
        data: {
          draft_order_id: draftOrder.id,
          product_id: params.productId,
          quantity: params.quantity,
          unit_price: unitPrice,
          total_price: unitPrice.mul(params.quantity),
          list_price: resolved.hasDiscount ? resolved.listPrice : null,
          discount_amount: resolved.hasDiscount ? resolved.discountAmount : null,
        }
      });
    }

    const items = await tx.draft_order_item.findMany({
      where: { draft_order_id: draftOrder.id }
    });

    const totalAmount = computeCartTotalDecimal(items);

    await tx.draft_order.update({
      where: { id: draftOrder.id },
      data: { total_amount: totalAmount }
    });
  });
};

const removeProductFromOrder = async (params: {
  conversationId: string;
  productId: string;
  quantity: number;
}): Promise<{ removedQuantity: number }> => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: params.conversationId },
    include: {
      business: { select: { id: true } },
      customer: { select: { phone_number: true } }
    }
  });

  if (!conversation) {
    throw new Error('Conversación no encontrada');
  }

  const result = await prisma.$transaction(async (tx) => {
    const draftOrder = await tx.draft_order.findFirst({
      where: {
        business_id: conversation.business.id,
        customer_phone: conversation.customer.phone_number,
        status: 'active'
      }
    });

    if (!draftOrder) {
      return { removedQuantity: 0 };
    }

    const existingItem = await tx.draft_order_item.findFirst({
      where: {
        draft_order_id: draftOrder.id,
        product_id: params.productId
      }
    });

    if (!existingItem) {
      return { removedQuantity: 0 };
    }

    const newQuantity = Math.max(existingItem.quantity - params.quantity, 0);
    const removedQuantity = existingItem.quantity - newQuantity;

    if (newQuantity === 0) {
      await tx.draft_order_item.delete({ where: { id: existingItem.id } });
    } else {
      await tx.draft_order_item.update({
        where: { id: existingItem.id },
        data: {
          quantity: newQuantity,
          total_price: existingItem.unit_price.mul(newQuantity)
        }
      });
    }

    const items = await tx.draft_order_item.findMany({
      where: { draft_order_id: draftOrder.id }
    });

    const totalAmount = computeCartTotalDecimal(items);

    await tx.draft_order.update({
      where: { id: draftOrder.id },
      data: { total_amount: totalAmount }
    });

    return { removedQuantity };
  });

  return result;
};

const sendCurrentOrderSummary = async (
  business: Business,
  conversation: Conversation,
  customer: Customer,
  to: string,
  phoneNumberId: string
): Promise<void> => {
  const draftOrder = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: to,
      status: 'active'
    }
  });

  const sender = new WhatsAppSenderService();

  if (!draftOrder) {
    const message = 'No tienes un pedido activo.';
    await sender.sendTextMessage({ phoneNumberId, to, message });
    await createConversationMessage(conversation.id, 'ai', message, false);
    await updateConversationLastMessageAt(conversation.id);
    return;
  }

  const items = await prisma.draft_order_item.findMany({
    where: { draft_order_id: draftOrder.id }
  });

  if (items.length === 0) {
    const message = 'Tu pedido esta vacio.';
    await sender.sendTextMessage({ phoneNumberId, to, message });
    await createConversationMessage(conversation.id, 'ai', message, false);
    await updateConversationLastMessageAt(conversation.id);
    return;
  }

  const menuItemIds = items.flatMap((item) =>
    item.product_id ? [item.product_id] : []
  );
  const menuItems =
    menuItemIds.length > 0
      ? await prisma.menu_item.findMany({
        where: { id: { in: menuItemIds } },
        select: { id: true, name: true }
      })
      : [];
  const menuItemMap = new Map(menuItems.map((item) => [item.id, item.name]));

  const lines: string[] = ['🛒 Pedido actual:', ''];
  for (const item of items) {
    const name = item.product_id ? menuItemMap.get(item.product_id) ?? 'Platillo' : 'Platillo';
    lines.push(`- ${item.quantity}x ${name}`);
  }
  lines.push('', `Total: $${draftOrder.total_amount.toFixed(2)} ${draftOrder.currency}`);

  await sender.sendInteractiveMenu({
    phoneNumberId,
    to,
    text: lines.join('\n'),
    buttons: [
      { title: 'Agregar más', payload: 'VIEW_MENU_RETURN' },
      { title: 'Cancelar pedido', payload: 'CANCEL_ORDER' },
      { title: 'Finalizar pedido', payload: 'CHECKOUT' }
    ]
  });

  await createConversationMessage(conversation.id, 'ai', lines.join('\n'), false);
  await updateConversationLastMessageAt(conversation.id);
};

const handleCancelOrder = async (
  business: Business,
  conversation: Conversation,
  customer: Customer,
  to: string,
  phoneNumberId: string
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    const draftOrder = await tx.draft_order.findFirst({
      where: {
        business_id: business.id,
        customer_phone: to,
        status: 'active'
      }
    });

    if (!draftOrder) {
      return;
    }

    await tx.draft_order_item.deleteMany({
      where: { draft_order_id: draftOrder.id }
    });

    await tx.draft_order.update({
      where: { id: draftOrder.id },
      data: {
        status: 'cancelled',
        total_amount: new Prisma.Decimal(0)
      }
    });
  });

  const sender = new WhatsAppSenderService();
  const message =
    'Tu pedido fue cancelado correctamente. ¿Quieres hacer otro pedido o terminar la conversacion?';

  await sender.sendInteractiveMenu({
    phoneNumberId,
    to,
    text: message,
    buttons: [
      { title: 'Empezar de nuevo', payload: 'VIEW_MENU_RETURN' },
      { title: 'Terminar chat', payload: 'END_CONVERSATION' }
    ]
  });

  await createConversationMessage(conversation.id, 'ai', message, false);
  await updateConversationLastMessageAt(conversation.id);
};

const handleEndConversation = async (
  conversation: Conversation,
  to: string,
  phoneNumberId: string
): Promise<void> => {
  await closeConversation(conversation.id);

  const sender = new WhatsAppSenderService();
  const message =
    'Gracias por escribirnos. Fue un gusto ayudarte. Cuando quieras, puedes volver a escribirnos y con gusto te atenderemos.';

  await sender.sendTextMessage({
    phoneNumberId,
    to,
    message
  });

  await createConversationMessage(conversation.id, 'ai', message, false);
  await updateConversationLastMessageAt(conversation.id);
};

export const handleCheckout = async (
  business: Business,
  conversation: Conversation,
  customer: Customer,
  to: string,
  phoneNumberId: string
): Promise<void> => {
  const result = await prisma.$transaction(async (tx) => {
    const draftOrder = await tx.draft_order.findFirst({
      where: {
        business_id: business.id,
        customer_phone: customer.phone_number,
        status: 'active'
      }
    });

    if (!draftOrder) {
      return { status: 'no_active' as const };
    }

    const items = await tx.draft_order_item.findMany({
      where: { draft_order_id: draftOrder.id }
    });

    if (items.length === 0) {
      return { status: 'empty' as const };
    }

    const totalAmount = computeCartTotalDecimal(items);

    // Snapshot de dirección solo si es DELIVERY
    let customerAddressId: string | undefined;
    let deliveryAddressSnapshot: object = {};
    if (draftOrder.fulfillment_type === 'DELIVERY') {
      const defaultAddress = await tx.customer_address.findFirst({
        where: { customer_id: customer.id, is_default: true }
      });
      if (defaultAddress) {
        customerAddressId = defaultAddress.id;
        deliveryAddressSnapshot = {
          street_address: defaultAddress.street_address,
          apartment: defaultAddress.apartment,
          neighborhood: defaultAddress.neighborhood,
          city: defaultAddress.city,
          postal_code: defaultAddress.postal_code,
          country: defaultAddress.country
        };
      }
    }

    const order = await tx.orders.create({
      data: {
        status: OrderStatus.placed,
        payment_status: OrderPaymentStatus.unpaid,
        currency_code: draftOrder.currency,
        total_amount: totalAmount,
        conversation_id: conversation.id,
        customer_id: customer.id,
        business_id: business.id,
        fulfillment_type: draftOrder.fulfillment_type ?? undefined,
        customer_address_id: customerAddressId,
        delivery_address_snapshot: deliveryAddressSnapshot
      }
    });

    const orderItems = items.flatMap((item) =>
      item.product_id
        ? [
          {
            order_id: order.id,
            menu_item_id: item.product_id,
            quantity: item.quantity,
            unit_price: item.unit_price
          }
        ]
        : []
    );

    if (orderItems.length > 0) {
      await tx.order_item.createMany({ data: orderItems });
    }

    await tx.draft_order.update({
      where: { id: draftOrder.id },
      data: { status: 'converted' }
    });

    return {
      status: 'ok' as const,
      orderId: order.id,
      total: totalAmount,
      currency: draftOrder.currency
    };
  });

  if (result.status === 'ok') {
    await closeConversation(conversation.id);
    emitAdminOrderCreated(business.id, {
      orderId: result.orderId,
      total: result.total.toFixed(2),
      currency: result.currency
    });
  }

  const sender = new WhatsAppSenderService();

  if (result.status === 'no_active') {
    const message = 'No tienes un pedido activo.';
    await sender.sendTextMessage({ phoneNumberId, to, message });
    await createConversationMessage(conversation.id, 'ai', message, false);
    await updateConversationLastMessageAt(conversation.id);
    return;
  }

  if (result.status === 'empty') {
    const message = 'Tu pedido está vacío.';
    await sender.sendTextMessage({ phoneNumberId, to, message });
    await createConversationMessage(conversation.id, 'ai', message, false);
    await updateConversationLastMessageAt(conversation.id);
    return;
  }

  const totalText = `$${result.total.toFixed(2)} ${result.currency}`;
  const message = `🧾 Pedido confirmado\n\nTotal: ${totalText}`;
  await sender.sendTextMessage({ phoneNumberId, to, message });
  await createConversationMessage(conversation.id, 'ai', message, false);
  await updateConversationLastMessageAt(conversation.id);
};

export class ValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export const sendTextMessage = async (
  payload: SendMessageRequest
): Promise<{ messageId: string }> => {
  const { to, message } = payload;

  if (!to || !message) {
    throw new ValidationError('Los campos "to" y "message" son requeridos');
  }

  // TODO: Implementar lógica de envío de mensaje con WhatsApp Cloud API
  const messageId = `msg_${Date.now()}`;

  return { messageId };
};

const buildListMessage = (params: {
  headerText: string;
  bodyText: string;
  footerText: string;
  actionButtonLabel: string;
  sections: Array<{ title: string; rows: Array<{ id: string; title: string; description: string }> }>;
}): WhatsAppListMessage => ({
  type: 'list',
  header: { type: 'text', text: params.headerText },
  body: { text: params.bodyText },
  footer: { text: params.footerText },
  action: {
    button: params.actionButtonLabel,
    sections: params.sections
  }
});

const buildListMessageFromButtons = (
  bodyText: string,
  buttons: { title: string; payload: string; description?: string; sectionTitle?: string }[],
  actionButtonLabel = 'Ver opciones',
  headerText = 'Opciones',
  footerText = 'Toca el botón de abajo para ver las opciones'
): WhatsAppListMessage => {
  const sections = new Map<string, Array<{ id: string; title: string; description: string }>>();
  for (const button of buttons) {
    const sectionTitle = button.sectionTitle ?? 'Opciones';
    const rows = sections.get(sectionTitle) ?? [];
    rows.push({
      id: button.payload,
      title: button.title,
      description: button.description ?? 'Selecciona esta opción'
    });
    sections.set(sectionTitle, rows);
  }

  return buildListMessage({
    headerText,
    bodyText,
    footerText,
    actionButtonLabel,
    sections: Array.from(sections.entries()).map(([title, rows]) => ({
      title,
      rows
    }))
  });
};

const buildOrderSearchListMessage = (params: {
  items: Array<{ id: string; name: string; description: string | null; ingredients: string | null }>;
  page: number;
}): WhatsAppListMessage => {
  const pageSize = 8;
  const totalCount = params.items.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(Math.max(params.page, 1), totalPages);
  const start = (safePage - 1) * pageSize;
  const end = start + pageSize;
  const pageItems = params.items.slice(start, end);

  console.log('---- MULTI MATCH PAGINATED ----');
  console.log('Page:', safePage);
  console.log('Total products:', totalCount);
  console.log('--------------------------------');

  const rows = pageItems.map((item) => ({
    id: `SELECT_ORDER_PRODUCT:${item.id}`,
    title: item.name,
    description: truncateDescription(item.description ?? item.ingredients ?? 'Sin descripción')
  }));

  if (safePage < totalPages) {
    rows.push({
      id: `ORDER_SEARCH_PAGE:${safePage + 1}`,
      title: '🔎 Ver más productos',
      description: 'Mostrar más resultados'
    });
  }

  rows.push({
    id: 'VIEW_MENU_RETURN',
    title: '📋 Ver todo el menú',
    description: 'Explorar categorías'
  });

  return buildListMessage({
    headerText: '',
    bodyText: '🤖\n\n*Nuestro menú disponible* 🍲\n\nNavega por las categorías y selecciona uno 👇',
    footerText: '',
    actionButtonLabel: 'Ver menú',
    sections: [
      { title: 'Menú', rows }
    ]
  });
};

const truncateDescription = (value: string, maxLength = 60): string =>
  value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;



type ConversationMetadata = {
  pendingProductSelection?: boolean;
  pendingQuestion?: string;
  candidateProductIds?: string[];
  /** @deprecated Lectura legacy; preferir requestedPartySize. */
  pendingProductQueryQuantity?: number;
  requestedPartySize?: number;
  peopleCount?: number;
  lastListSuggestedQuantity?: number;
  coveredPortions?: number;
  missingPortions?: number;
  pendingOrderSelection?: boolean;
  pendingOrderMessage?: string;
  pendingOrderCandidateIds?: string[];
};

type ConversationMode = 'GLOBAL' | 'FILTER_SET' | 'PRODUCT_FOCUS';

const normalizeMetadata = (value: unknown): ConversationMetadata => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as ConversationMetadata;
  }
  return {};
};

const handlePendingAction = async (params: {
  conversationId: string;
  pendingAction: string;
  messageText: string;
}): Promise<string | WhatsAppListMessage | WhatsAppInteractiveMessage | null> => {
  const { conversationId, pendingAction, messageText } = params;
  const normalized = pendingAction.trim().toLowerCase();

  if (!messageText.trim()) {
    return null;
  }

  if (
    normalized === 'awaiting_address' ||
    normalized === 'awaiting_quantity' ||
    normalized === 'awaiting_confirmation'
  ) {
    const responseText = 'Gracias, ya registré la información.';
    await updateConversationState(conversationId, {
      pending_action: null,
      metadata: Prisma.JsonNull
    } as Prisma.conversation_stateUpdateInput & { pending_action?: string | null });
    await createConversationMessage(conversationId, 'ai', responseText, false);
    await updateConversationLastMessageAt(conversationId);
    return responseText;
  }

  return null;
};

const buildMetadataValue = (
  metadata: ConversationMetadata
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput => {
  return Object.keys(metadata).length === 0
    ? Prisma.JsonNull
    : (metadata as Prisma.InputJsonValue);
};

const clearPendingSelection = (metadata: ConversationMetadata): ConversationMetadata => {
  if (
    !metadata.pendingProductSelection &&
    !metadata.pendingQuestion &&
    !metadata.candidateProductIds &&
    !metadata.pendingOrderSelection &&
    !metadata.pendingOrderMessage &&
    !metadata.pendingOrderCandidateIds
  ) {
    return metadata;
  }
  return {};
};

const getLastUserMessage = (
  messages: OpenAITypes.Chat.ChatCompletionMessageParam[]
): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'user' && typeof message.content === 'string') {
      return message.content;
    }
  }
  return '';
};

const buildSmallTalkResponse = async (
  conversationId: string,
  isFirstMessage: boolean,
  hasGreeted: boolean
): Promise<WhatsAppListMessage> => {
  const messageText = isFirstMessage && !hasGreeted
    ? 'Hola! Bienvenido/a 👋\nEstoy aqui para ayudarte. Elige una opcion para comenzar.'
    : 'Hola de nuevo! soy el nuevo asistente de IA, estoy para ayudarte.😊\n¿Quieres ver el menu o tienes una duda?';

  await createConversationMessage(conversationId, 'ai', messageText, false);
  await updateConversationState(conversationId, { current_intent: 'greeted' });
  await updateConversationLastMessageAt(conversationId);

  return buildListMessage({
    headerText: '¿Cómo te ayudo?',
    bodyText: messageText,
    footerText: 'Toca el botón de abajo para ver las opciones',
    actionButtonLabel: 'Ver opciones',
    sections: [
      {
        title: 'Opciones',
        rows: [
          {
            id: 'VIEW_MENU_RETURN',
            title: 'Ver menú',
            description: 'Explorar categorías y platillos'
          },
          {
            id: 'ASK_QUESTION',
            title: 'Necesito info',
            description: 'Hacer una consulta'
          }
        ]
      }
    ]
  });
};

const buildUnknownResponse = async (
  conversationId: string
): Promise<WhatsAppListMessage> => {
  const messageText =
    'No estoy seguro de haber entendido. ¿Quieres ver el menu o necesitas informacion?';

  await createConversationMessage(conversationId, 'ai', messageText, false);
  await updateConversationLastMessageAt(conversationId);

  return buildListMessage({
    headerText: '¿Cómo te ayudo?',
    bodyText: messageText,
    footerText: 'Toca el botón de abajo para ver las opciones',
    actionButtonLabel: 'Ver opciones',
    sections: [
      {
        title: 'Opciones',
        rows: [
          {
            id: 'VIEW_MENU_RETURN',
            title: 'Ver menú',
            description: 'Explorar categorías y platillos'
          },
          {
            id: 'ASK_QUESTION',
            title: 'Necesito info',
            description: 'Hacer una consulta'
          }
        ]
      }
    ]
  });
};

const buildViewMenuResponse = async (
  businessId: string,
  customerId: string,
  conversationId: string,
  hasGreeted: boolean
): Promise<string | WhatsAppListMessage> => {
  if (!hasGreeted) {
    const menuResponse = await MenuService.getMenuForCustomer({ businessId, customerId });
    await createConversationMessage(conversationId, 'ai', menuResponse.text, true);
    await updateConversationLastMessageAt(conversationId);
    await updateConversationState(conversationId, { current_intent: 'greeted' });

    if (menuResponse.buttons.length === 0) {
      return menuResponse.text;
    }

    return buildListMessageFromButtons(
      menuResponse.text,
      menuResponse.buttons,
      'Ver opciones disponibles',
      'Menú'
    );
  }

  const menuResponse = await MenuService.getCategoryListForCustomer({
    businessId,
    customerId
  });

  const pages = buildCategoryListPages(menuResponse.buttons);
  const totalPages = pages.length;
  const safePage = Math.min(Math.max(1, 1), totalPages || 1);
  const currentPage = pages[safePage - 1];
  let pageText = `📋 Categorías (pagina ${safePage} de ${totalPages})\n\nSelecciona una categoría o usa las opciones para navegar.`;

  if (safePage === 1) {
    const menuHeader = await MenuService.getMenuForCustomer({
      businessId,
      customerId
    });
    pageText = menuHeader.text;
  }

  await createConversationMessage(conversationId, 'ai', menuResponse.text, true);
  await updateConversationLastMessageAt(conversationId);
  await updateConversationState(conversationId, { current_intent: 'greeted' });

  return buildListMessageFromButtons(
    pageText,
    currentPage?.buttons ?? [],
    'Elige categoria',
    'Categorías'
  );
};

const buildViewOrderResponse = async (
  business: Business,
  conversation: Conversation,
  customer: Customer,
  to: string
): Promise<string | WhatsAppListMessage> => {
  const draftOrder = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: to,
      status: 'active'
    }
  });

  if (!draftOrder) {
    const message = 'No tienes un pedido activo.';
    await createConversationMessage(conversation.id, 'ai', message, false);
    await updateConversationLastMessageAt(conversation.id);
    return message;
  }

  const items = await prisma.draft_order_item.findMany({
    where: { draft_order_id: draftOrder.id }
  });

  if (items.length === 0) {
    const message = 'Tu pedido esta vacio.';
    await createConversationMessage(conversation.id, 'ai', message, false);
    await updateConversationLastMessageAt(conversation.id);
    return message;
  }

  const menuItemIds = items.flatMap((item) =>
    item.product_id ? [item.product_id] : []
  );
  const menuItems =
    menuItemIds.length > 0
      ? await prisma.menu_item.findMany({
        where: { id: { in: menuItemIds } },
        select: { id: true, name: true }
      })
      : [];
  const menuItemMap = new Map(menuItems.map((item) => [item.id, item.name]));

  const lines: string[] = ['🛒 Pedido actual:', ''];
  for (const item of items) {
    const name = item.product_id ? menuItemMap.get(item.product_id) ?? 'Platillo' : 'Platillo';
    lines.push(`- ${item.quantity}x ${name}`);
  }
  lines.push('', `Total: $${draftOrder.total_amount.toFixed(2)} ${draftOrder.currency}`);

  const bodyText = lines.join('\n');

  await createConversationMessage(conversation.id, 'ai', bodyText, false);
  await updateConversationLastMessageAt(conversation.id);

  return buildListMessage({
    headerText: 'Pedido actual',
    bodyText,
    footerText: 'Toca el botón de abajo para ver las opciones',
    actionButtonLabel: 'Acciones',
    sections: [
      {
        title: 'Acciones',
        rows: [
          {
            id: 'VIEW_MENU_RETURN',
            title: 'Agregar más',
            description: 'Ver más platillos'
          },
          {
            id: 'CANCEL_ORDER',
            title: 'Cancelar pedido',
            description: 'Cancelar el pedido actual'
          },
          {
            id: 'CHECKOUT',
            title: 'Finalizar pedido',
            description: 'Continuar al pago'
          }
        ]
      }
    ]
  });
};

const buildImplicitProductResponse = async ({
  business,
  customer,
  conversation,
  lastReferencedProductId,
  lastUserMessage,
  logLabel,
  additionalLogLine
}: {
  business: Business;
  customer: Customer;
  conversation: Conversation;
  lastReferencedProductId: string;
  lastUserMessage: string;
  logLabel: string;
  additionalLogLine?: string;
}): Promise<string | null> => {
  const product = await prisma.menu_item.findUnique({
    where: { id: lastReferencedProductId },
    select: {
      id: true,
      name: true,
      description: true,
      ingredients: true,
      serves_people: true,
      is_available: true
    }
  });

  if (!product) {
    return null;
  }

  console.log(logLabel);
  if (additionalLogLine) {
    console.log(additionalLogLine);
  }
  console.log('Using lastReferencedProductId:', product.id);
  console.log('User message:', lastUserMessage);
  console.log('-------------------------------------');

  const currency = customer.preferred_currency ?? business.currency_code ?? null;
  const now = new Date();
  const priceWhere = {
    is_active: true,
    valid_from: { lte: now },
    OR: [{ valid_to: null }, { valid_to: { gte: now } }],
    ...(currency ? { currency_code: currency } : {})
  };

  const activePrice = await prisma.menu_item_price.findFirst({
    where: {
      menu_item_id: product.id,
      ...priceWhere
    },
    orderBy: { valid_from: 'desc' }
  });

  const convStateForParty = await findOrCreateConversationState(conversation.id);
  const requestedPartySize = getRequestedPartySize(
    normalizeMetadata(convStateForParty.metadata)
  );

  const aiResponse = await generateProductAwareResponse({
    businessId: business.id,
    product: {
      name: product.name,
      description: product.description,
      ingredients: product.ingredients,
      serves_people: product.serves_people,
      is_available: product.is_available,
      price: activePrice
        ? {
          amount: activePrice.amount,
          currency_code: activePrice.currency_code
        }
        : null
    },
    userQuestion: lastUserMessage,
    requestedPartySize
  });

  await createConversationMessage(conversation.id, 'ai', aiResponse, true);
  await updateConversationLastMessageAt(conversation.id);
  return aiResponse;
};

const normalize = (str: string) =>
  str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

const buildResponse = async ({
  intent,
  business,
  customer,
  conversation,
  from,
  isFirstMessage,
  hasGreeted,
  formattedMessages,
  detectedProductName,
  lastUserMessage,
  lastReferencedProductId,
  mode,
  candidateProductIds
}: {
  intent: ConversationIntent;
  business: Business;
  customer: Customer;
  conversation: Conversation;
  from: string;
  isFirstMessage: boolean;
  hasGreeted: boolean;
  formattedMessages: OpenAITypes.Chat.ChatCompletionMessageParam[];
  detectedProductName: string | null;
  lastUserMessage: string;
  lastReferencedProductId: string | null;
  mode: ConversationMode;
  candidateProductIds: string[] | null;
}): Promise<string | WhatsAppListMessage | WhatsAppInteractiveMessage> => {
  console.debug('Conversation mode:', mode);

  // =========================
  // PAYMENT
  // =========================
  if (intent === ConversationIntent.PAYMENT_METHODS) {
    const messageText = 'Aceptamos efectivo y transferencia.';
    await createConversationMessage(conversation.id, 'ai', messageText, false);
    await updateConversationLastMessageAt(conversation.id);
    return messageText;
  }

  if (intent === ConversationIntent.PAYMENT_REQUEST) {
    return buildViewOrderResponse(business, conversation, customer, from);
  }

  // =========================
  // ORDER
  // =========================
  if (intent === ConversationIntent.ORDER_FOOD) {

    let activeOrder = await prisma.draft_order.findFirst({
      where: {
        business_id: business.id,
        customer_phone: from,
        status: 'active'
      }
    });

    if (!activeOrder) {
      activeOrder = await prisma.draft_order.create({
        data: {
          business_id: business.id,
          customer_phone: from,
          status: 'active',
          currency: business.currency_code ?? 'ARS',
          total_amount: 0
        }
      });
    }

    const draftItems = await prisma.draft_order_item.findMany({
      where: { draft_order_id: activeOrder.id }
    });

    const menuItems =
      draftItems.length > 0
        ? await prisma.menu_item.findMany({
          where: {
            id: { in: draftItems.map(i => i.product_id).filter(Boolean) as string[] }
          },
          select: { id: true, name: true, is_available: true }
        })
        : [];

    const menuMap = new Map(menuItems.map(m => [m.id, m.name]));

    const currentOrderItems = draftItems.map(item => ({
      name: item.product_id ? menuMap.get(item.product_id) ?? 'Producto' : 'Producto',
      quantity: item.quantity
    }));

    const resolution = await generateOrderResolution({
      userMessage: lastUserMessage,
      currentOrderItems
    });

    // =========================
    // PEDIDO VACÍO + CONTEXTO
    // =========================
    if (draftItems.length === 0 && lastReferencedProductId) {

      if (resolution.actions.length === 0) {
        const focused = await prisma.menu_item.findUnique({
          where: { id: lastReferencedProductId }
        });

        if (focused) {
          await addProductToOrder({
            conversationId: conversation.id,
            productId: focused.id,
            quantity: 1
          });

          return await buildUpdatedOrderResponse({ conversation, business, from });
        }
      }
    }

    // =========================
    // NEEDS CLARIFICATION
    // =========================
    if (resolution.needs_clarification && draftItems.length > 0) {

      const listMessage = buildListMessage({
        headerText: '¿Cuál deseas modificar?',
        bodyText: 'Selecciona el producto del pedido 👇',
        footerText: 'Elige una opción',
        actionButtonLabel: 'Ver pedido',
        sections: [
          {
            title: 'Tu pedido',
            rows: menuItems.map((item) => ({
              id: `ORDER_SELECT_${item.id}`,
              title: item.name,
              description: `${draftItems.find(i => i.product_id === item.id)?.quantity ?? 0}x`
            }))
          }
        ]
      });

      await createConversationMessage(conversation.id, 'ai', listMessage.body.text, false);
      await updateConversationLastMessageAt(conversation.id);

      return listMessage;
    }

    // =========================
    // EJECUTAR ACCIONES (MULTI)
    // =========================

    for (const action of resolution.actions) {

      const quantity = action.quantity && action.quantity > 0 ? action.quantity : 1;

      // ADD

      if (action.action === "add") {

        const products = await MenuService.searchMenuItemsForOrder({
          businessId: business.id,
          keyword: action.product_name
        });
      
        const normalizedTarget = normalize(action.product_name);
      
        const exactMatch = products.find(p =>
          normalize(p.name) === normalizedTarget
        );
      
        const strongMatch = products.find(p =>
          normalize(p.name).includes(normalizedTarget)
        );
      
        // 🔒 Política enterprise segura
        let match: MenuItemSearchResult | null = null;
      
        if (exactMatch) {
          match = exactMatch;
        } else if (products.length === 1 && strongMatch) {
          match = strongMatch;
        }
      
        if (!match) {
          return buildListMessage({
            headerText: '',
            bodyText: '*¿Qué producto querés agregar?\n*Tenemos algunos resultados para tu consulta* \nSelecciona uno 👇',
            footerText: 'Elige una opción',
            actionButtonLabel: 'Ver opciones',
            sections: [
              { title: 'Productos', rows: products.slice(0, 5).map(p => ({ id: `PRODUCT_${p.id}`, title: p.name, description: p.description ?? '' })) }
            ]
          });
        }
      
        await addProductToOrder({
          conversationId: conversation.id,
          productId: match.id,
          quantity
        });
      
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastReferencedProductId: match.id }
        });
      }


      // REMOVE
      if (action.action === "remove") {

        const target = menuItems.find(item =>
          normalize(item.name).includes(normalize(action.product_name))
        );

        if (!target) continue;

        await removeProductFromOrder({
          conversationId: conversation.id,
          productId: target.id,
          quantity
        });
      }

      // SET QUANTITY
      if (action.action === "set_quantity") {

        const target = menuItems.find(item =>
          normalize(item.name).includes(normalize(action.product_name))
        );

        if (!target) continue;

        await setProductQuantity({
          conversationId: conversation.id,
          productId: target.id,
          quantity
        });
      }
    }

    return await buildUpdatedOrderResponse({
      conversation,
      business,
      from
    });
  }

  // =========================
  // VIEW ORDER
  // =========================
  if (intent === ConversationIntent.VIEW_CART) {
    return buildViewOrderResponse(business, conversation, customer, from);
  }

  // =========================
  // VIEW MENU
  // =========================

  if (intent === ConversationIntent.VIEW_MENU) {

    // 🔥 Reset context
    await updateConversationState(conversation.id, {
      mode: "GLOBAL",
      metadata: {}
    });
  
    const items = await prisma.menu_item.findMany({
      where: {
        business_id: business.id,
        is_available: true
      },
      orderBy: { created_at: 'asc' },
      select: {
        id: true,
        name: true,
        description: true,
        ingredients: true
      }
    });


  const listMessage: WhatsAppListMessage = await buildOrderSearchListMessage({
    items,
    page:1
  });
  
    await createConversationMessage(conversation.id, 'ai', listMessage.body.text, false);
    await updateConversationLastMessageAt(conversation.id);
  
    return listMessage;
  }

  // =========================
  // PRODUCT ATTRIBUTE QUESTION (CONTEXT SET)
  // =========================
  if (intent === ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION) {
    const state = await findOrCreateConversationState(conversation.id);
    const metadata = normalizeMetadata(state.metadata);
    const candidateIds = candidateProductIds ?? metadata.candidateProductIds ?? null;

    // 🔥 CASO 1: Tenemos producto en foco
    if (mode === 'PRODUCT_FOCUS' && lastReferencedProductId) {
      const implicit = await buildImplicitProductResponse({
        business,
        customer,
        conversation,
        lastReferencedProductId,
        lastUserMessage,
        logLabel: '---- ATTRIBUTE VIA PRODUCT FOCUS ----'
      });

      if (implicit) return implicit;
    }

    // 🔥 CASO 2: Tenemos conjunto activo
    if (mode === 'FILTER_SET' && candidateIds && candidateIds.length > 0) {
      if (conversation.lastReferencedProductId) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastReferencedProductId: null }
        });
      }

      const products = await prisma.menu_item.findMany({
        where: { id: { in: candidateIds } },
        include: { menu_item_price: true }
      });

      if (products.length === 0) {
        return buildUnknownResponse(conversation.id);
      }

      const result = await generateFilteredSetResponse({
        businessId: business.id,
        products,
        userQuestion: lastUserMessage
      });

      const recommendedIds = result.recommended_product_ids ?? [];
      const reason = result.reason ?? '';

      if (recommendedIds.length === 0) {
        await createConversationMessage(conversation.id, 'ai', reason, false);
        await updateConversationLastMessageAt(conversation.id);
        return reason;
      }

      if (recommendedIds.length === 1) {

        const product = products.find(p => p.id === recommendedIds[0]);
        if (!product) return buildUnknownResponse(conversation.id);

        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastReferencedProductId: product.id }
        });
        const cleanedMetadata = clearProductFilterMetadata(metadata);
        console.debug('Conversation mode:', 'PRODUCT_FOCUS');
        await updateConversationState(conversation.id, {
          mode: 'PRODUCT_FOCUS',
          metadata: buildMetadataValue(cleanedMetadata)
        } as Prisma.conversation_stateUpdateInput & { mode?: ConversationMode });

        const messageText = `${reason}\n\n¿Deseas agregar ${product.name}?`;

        await createConversationMessage(conversation.id, 'ai', messageText, false);
        await updateConversationLastMessageAt(conversation.id);

        return {
          type: 'interactive',
          interactive: {
            type: 'button',
            header: { type: 'text', text: 'Recomendación' },
            body: { text: messageText },
            footer: { text: 'Elige una opción' },
            action: {
              buttons: [
                {
                  type: 'reply',
                  reply: {
                    id: 'ADD_ITEM',
                    title: 'Agregar'
                  }
                }
              ]
            }
          }
        };
      }

      const listMessage = buildListMessage({
        headerText: 'Opciones recomendadas',
        bodyText: reason,
        footerText: 'Selecciona uno',
        actionButtonLabel: 'Ver opciones',
        sections: [
          {
            title: 'Recomendaciones',
            rows: products
              .filter(p => recommendedIds.includes(p.id))
              .map(p => ({
                id: `SELECT_PRODUCT:${p.id}`,
                title: p.name,
                description: truncateDescription(p.description ?? '')
              }))
          }
        ]
      });

      console.debug('Conversation mode:', 'FILTER_SET');
      await updateConversationState(conversation.id, {
        mode: 'FILTER_SET',
        metadata: buildMetadataValue({
          pendingProductSelection: true,
          pendingQuestion: lastUserMessage,
          candidateProductIds: recommendedIds
        })
      } as Prisma.conversation_stateUpdateInput & { mode?: ConversationMode });
      await createConversationMessage(conversation.id, 'ai', reason, false);
      await updateConversationLastMessageAt(conversation.id);

      return listMessage;

    }

    // 🔥 CASO 3: No hay contexto → pedir aclaración
    const clarification =
      '¿Sobre qué platillo quieres saber eso? Puedes decirme el nombre o pedirme ver opciones.';

    await createConversationMessage(conversation.id, 'ai', clarification, false);
    await updateConversationLastMessageAt(conversation.id);

    return clarification;
  }

  // =========================
  // PRODUCT QUERY
  // =========================
  if (intent === ConversationIntent.PRODUCT_QUERY && detectedProductName) {

    const keyword = detectedProductName.trim();

    const items = await MenuService.searchMenuItemsByKeyword({
      businessId: business.id,
      keyword
    });

    if (items.length === 0) {
      const messageText = `No encontramos productos relacionados con "${keyword}" en nuestro menú.`;
      await createConversationMessage(conversation.id, 'ai', messageText, false);
      await updateConversationLastMessageAt(conversation.id);
      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          header: { type: 'text', text: 'Sin resultados a tu consulta' },
          body: { text: messageText },
          footer: { text: 'Elige una opción' },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: {
                  id: 'VIEW_MENU',
                  title: 'Ver manù',
                }
              }
            ]
          }
        }
      };
    }

    if (items.length > 1) {
      const stateMultiLegacy = await findOrCreateConversationState(conversation.id);
      const rawMultiLegacy = normalizeMetadata(stateMultiLegacy.metadata);
      const partyLegacy = getRequestedPartySize(rawMultiLegacy);
      const baseMultiLegacy = withoutLegacyPartyQuantity(
        clearProductFilterMetadata(rawMultiLegacy)
      );
      console.debug('Conversation mode:', 'FILTER_SET');
      await updateConversationState(conversation.id, {
        mode: 'FILTER_SET',
        metadata: buildMetadataValue({
          ...baseMultiLegacy,
          pendingProductSelection: true,
          pendingQuestion: lastUserMessage,
          candidateProductIds: items.map((item) => item.id),
          ...(partyLegacy != null ? partySizeMetadataFields(partyLegacy) : {})
        })
      } as Prisma.conversation_stateUpdateInput & { mode?: ConversationMode });
      if (conversation.lastReferencedProductId) {
        await prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastReferencedProductId: null }
        });
      }

      const listMessage = buildListMessage({
        headerText: '',
        bodyText: '*Tenemos algunos resultados para tu consulta* \n Selecciona uno 👇',
        footerText: 'Elige una opción',
        actionButtonLabel: 'Ver opciones',
        sections: [
          {
            title: 'Resultados',
            rows: items.map((item) => ({
              id: `SELECT_PRODUCT:${item.id}`,
              title: item.name,
              description: truncateDescription(
                item.description ?? item.ingredients ?? 'Sin descripción'
              )
            }))
          }
        ]
      });

      await createConversationMessage(conversation.id, 'ai', listMessage.body.text, false);
      await updateConversationLastMessageAt(conversation.id);
      return listMessage;
    }

    const matchedItem = items[0];

    const stateSingleLegacy = await findOrCreateConversationState(conversation.id);
    const rawSingleLegacy = normalizeMetadata(stateSingleLegacy.metadata);
    const partySingleLegacy = getRequestedPartySize(rawSingleLegacy);

    const aiResponse = await generateProductAwareResponse({
      businessId: business.id,
      product: {
        name: matchedItem.name,
        description: matchedItem.description,
        ingredients: matchedItem.ingredients,
        serves_people: matchedItem.serves_people,
        is_available: matchedItem.is_available,
        price: {
          amount: matchedItem.menu_item_price[0]?.amount ?? 0,
          currency_code: matchedItem.menu_item_price[0]?.currency_code ?? 'ARS'
        }
      },
      userQuestion: lastUserMessage,
      requestedPartySize: partySingleLegacy
    });

    await createConversationMessage(conversation.id, 'ai', aiResponse, true);
    await updateConversationLastMessageAt(conversation.id);

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastReferencedProductId: matchedItem.id }
    });
    const cleanedSingleLegacy = clearProductFilterMetadata(rawSingleLegacy);
    const nextSingleLegacy = {
      ...withoutLegacyPartyQuantity(cleanedSingleLegacy),
      ...(partySingleLegacy != null
        ? partySizeMetadataFields(partySingleLegacy)
        : {})
    };
    console.debug('Conversation mode:', 'PRODUCT_FOCUS');
    await updateConversationState(conversation.id, {
      mode: 'PRODUCT_FOCUS',
      metadata: buildMetadataValue(nextSingleLegacy)
    } as Prisma.conversation_stateUpdateInput & { mode?: ConversationMode });

    return aiResponse;
  }

  // =========================
  // SMALL TALK
  // =========================
  if (intent === ConversationIntent.SMALL_TALK) {
    return buildSmallTalkResponse(conversation.id, isFirstMessage, hasGreeted);
  }

  

  if (intent === ConversationIntent.UNKNOWN) {
    return buildUnknownResponse(conversation.id);
  }

  const aiResponse = await generateAIResponse(business, formattedMessages);

  await createConversationMessage(
    conversation.id,
    'ai',
    aiResponse.content,
    true
  );

  await updateConversationLastMessageAt(conversation.id);

  return aiResponse.content;
};

const processConfirmationResponse = (
  response: string,
  candidates: Array<{ intent: ConversationIntent; label: string }>
): ConversationIntent | null => {
  const normalized = response.trim().toLowerCase();

  const numMatch = normalized.match(/^[1-9]$/);
  if (numMatch) {
    const index = parseInt(numMatch[0], 10) - 1;
    if (index >= 0 && index < candidates.length) {
      return candidates[index].intent;
    }
  }

  if (['sí', 'si', 'yes', 'ok', 'vale', 'correcto'].includes(normalized)) {
    return candidates[0].intent;
  }

  return null;
};

export const processIncomingMessage = async (
  payload: WhatsAppWebhookPayload
): Promise<string | WhatsAppListMessage | WhatsAppInteractiveMessage> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;

  const message = value?.messages?.[0];
  const messageId = message?.id;

  if (!message) {
    await processStatus(payload);
    return '';
  }

  const from = message.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from) return '';

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return '';

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  const conversationState = await findOrCreateConversationState(conversation.id);
  const stateMode =
    ((conversationState as unknown as { mode?: string }).mode ??
      'GLOBAL') as ConversationMode;
  const stateMetadata = normalizeMetadata(conversationState.metadata);
  const candidateProductIds = stateMetadata.candidateProductIds ?? null;

  if (messageId) {
    const existingMessage = await findByWhatsappMessageId(messageId);
    if (existingMessage) return '';
  }

  const existingMessages = await getRecentMessagesByConversationId(
    conversation.id,
    20,
    conversation.started_at
  );
  const isFirstMessage = existingMessages.length === 0;

  // Persist message
  const messageContent =
    message.type === 'text'
      ? message.text?.body ?? ''
      : message.type === 'interactive'
        ? message.interactive?.button_reply?.id ??
        message.interactive?.list_reply?.id ??
        '[interactive]'
        : `[${message.type ?? 'unknown'}]`;

  const persistedMessage = await createConversationMessage(
    conversation.id,
    'customer',
    messageContent,
    false,
    messageId,
    messageId
  );

  if (!persistedMessage) {
    return '';
  }

  await updateConversationLastMessageAt(conversation.id);

  const newMessage: OpenAITypes.Chat.ChatCompletionMessageParam = {
    role: 'user',
    content: messageContent
  };
  const formattedMessages: OpenAITypes.Chat.ChatCompletionMessageParam[] =
    existingMessages.map(
      (recentMessage) =>
      ({
        role: recentMessage.is_ai_generated ? 'assistant' : 'user',
        content: recentMessage.message
      } as OpenAITypes.Chat.ChatCompletionMessageParam)
    );
  formattedMessages.push(newMessage);
  const hasGreeted = conversationState.current_intent === 'greeted';

  // =====================================================
  // 🔥 PRIORITY 1: INTERACTIVE EVENTS (NO NLP)
  // =====================================================

  if (message.type === 'interactive') {
    const interactive = message.interactive;

    // BUTTONS
    if (interactive?.button_reply) {
      const buttonId = interactive.button_reply.id;

      switch (buttonId) {
        case 'ADD_ITEM':
          if (!conversation.lastReferencedProductId) return '';
          await handleAddItemFromWebhook(
            payload,
            conversation.lastReferencedProductId
          );
          return '';

        case 'VIEW_MENU':
          return await buildResponse({
            intent: ConversationIntent.VIEW_MENU,
            business,
            customer,
            conversation,
            from,
            isFirstMessage,
            hasGreeted,
            formattedMessages,
            detectedProductName: null,
            lastUserMessage: '',
            lastReferencedProductId:
              conversation.lastReferencedProductId ?? null,
            mode: stateMode,
            candidateProductIds
          });

        case 'VIEW_CART':
          return await buildResponse({
            intent:ConversationIntent.VIEW_CART,
            business,
            customer,
            conversation,
            from,
            isFirstMessage,
            hasGreeted,
            formattedMessages,
            detectedProductName: null,
            lastUserMessage: '',
            lastReferencedProductId:
              conversation.lastReferencedProductId ?? null,
            mode: stateMode,
            candidateProductIds
          });

        default:
          return '';
      }
    }

    // LIST SELECTION
    if (interactive?.list_reply) {
      const selectedId = interactive.list_reply.id ?? '';
      const response = await handleProductSelectionFromWebhook(payload, selectedId);
      return response ?? '';
    }
  }

  // =====================================================
  // 🔥 PRIORITY 2: TEXT → NLP
  // =====================================================

  if (message.type !== 'text') return '';

  const text = message.text?.body ?? '';
  const lastUserMessage = text;

  const pendingAction =
    (conversationState as unknown as { pending_action?: string | null })
      .pending_action ?? null;
  if (pendingAction) {
    const pendingResponse = await handlePendingAction({
      conversationId: conversation.id,
      pendingAction,
      messageText: text
    });
    if (pendingResponse) {
      return pendingResponse;
    }
  }

  let detectionResult;
  try {
    detectionResult = await detectIntentWithConfidence(text, {
      conversationMode: stateMode,
      lastReferencedProductId: conversation.lastReferencedProductId,
      candidateProductIds: candidateProductIds,
      recentMessages: existingMessages.map(m => m.message),
      lastReferencedProductName: (conversationState.metadata as any)?.lastReferencedProductName || null
    });
  } catch (error) {
    detectionResult = null;
  }

  let resolvedIntent: ConversationIntent;
  if (detectionResult?.type === 'UNCERTAIN') {
    resolvedIntent =
      detectionResult.candidates[0]?.intent ?? ConversationIntent.UNKNOWN;
  } else if (detectionResult) {
    resolvedIntent = detectionResult.intent;
  } else {
    resolvedIntent = ConversationIntent.UNKNOWN;
  }

  // 🔥 CONTEXT OVERRIDE: PRODUCT_FOCUS dominates PRODUCT_QUERY

  if (
    conversationState.mode === "PRODUCT_FOCUS" &&
    resolvedIntent === ConversationIntent.PRODUCT_QUERY &&
    detectionResult?.detectedProductName
  ) {
    console.debug("Override PRODUCT_QUERY → PRODUCT_ATTRIBUTE_QUESTION due to PRODUCT_FOCUS mode");

    resolvedIntent = ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION;
  }

  console.log('---- INTENT DETECTED ----');
  console.log('User message:', text);
  console.log('Intent:', resolvedIntent);
  console.log('Detected product:', detectionResult?.detectedProductName ?? null);
  console.log('-------------------------');

  // Clear product context when appropriate
  const intentsToClearContext = new Set<ConversationIntent>([
    ConversationIntent.SMALL_TALK,
    ConversationIntent.BUSINESS_HOURS,
    ConversationIntent.BUSINESS_LOCATION,
    ConversationIntent.DELIVERY_INFO,
    ConversationIntent.PAYMENT_METHODS,
    ConversationIntent.SUPPORT,
    ConversationIntent.UNKNOWN
  ]);

  if (
    intentsToClearContext.has(resolvedIntent) &&
    !detectionResult?.detectedProductName &&
    (conversation.lastReferencedProductId || candidateProductIds?.length)
  ) {
    if (conversation.lastReferencedProductId) {
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastReferencedProductId: null }
      });
    }
    const clearedForGlobal = clearProductFilterMetadata(stateMetadata);
    const {
      requestedPartySize: _rp,
      peopleCount: _pc,
      pendingProductQueryQuantity: _pq,
      ...globalMeta
    } = clearedForGlobal;
    void _rp;
    void _pc;
    void _pq;
    console.debug('Conversation mode:', 'GLOBAL');
    await updateConversationState(conversation.id, {
      mode: 'GLOBAL',
      metadata: buildMetadataValue(globalMeta)
    } as Prisma.conversation_stateUpdateInput & { mode?: ConversationMode });
  }

  try {
    return await buildResponse({
      intent: resolvedIntent,
      business,
      customer,
      conversation,
      from,
      isFirstMessage,
      hasGreeted,
      formattedMessages,
      detectedProductName: detectionResult?.detectedProductName ?? null,
      lastUserMessage,
      lastReferencedProductId:
        conversation.lastReferencedProductId ?? null,
      mode: stateMode,
      candidateProductIds
    });
  } catch (error) {
    const messageText = 'Lo siento, ocurrió un error. Intenta de nuevo.';
    await createConversationMessage(conversation.id, 'ai', messageText, false);
    await updateConversationLastMessageAt(conversation.id);
    return messageText;
  }
};

export const processStatus = async (
  payload: WhatsAppWebhookPayload
): Promise<void> => {
  void payload;
};

export const verifyWebhook = (
  query: Record<string, unknown>
): { isValid: boolean; challenge?: string } => {
  const mode = typeof query['hub.mode'] === 'string' ? query['hub.mode'] : undefined;
  const token =
    typeof query['hub.verify_token'] === 'string'
      ? query['hub.verify_token']
      : undefined;
  const challenge =
    typeof query['hub.challenge'] === 'string' ? query['hub.challenge'] : undefined;

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;

  const isValid = mode === 'subscribe' && token === verifyToken;

  return { isValid, challenge };
};

const buildUpdatedOrderResponse = async ({
  conversation,
  business,
  from
}: {
  conversation: Conversation;
  business: Business;
  from: string;
}) => {

  const draftOrder = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: from,
      status: 'active'
    }
  });

  if (!draftOrder) {
    return 'Tu pedido está vacío.';
  }

  const items = await prisma.draft_order_item.findMany({
    where: { draft_order_id: draftOrder.id }
  });

  if (items.length === 0) {
    return 'Tu pedido está vacío.';
  }

  const menuItems = await prisma.menu_item.findMany({
    where: {
      id: { in: items.map(i => i.product_id).filter(Boolean) as string[] }
    },
    select: { id: true, name: true }
  });

  const menuMap = new Map(menuItems.map(m => [m.id, m.name]));

  const lines = [
    '🛒 Pedido actual:',
    ''
  ];

  for (const item of items) {
    const name = item.product_id ? menuMap.get(item.product_id) ?? 'Producto' : 'Producto';
    lines.push(`- ${item.quantity}x ${name}`);
  }

  lines.push('', `Total: $${draftOrder.total_amount.toFixed(2)} ${draftOrder.currency}`);

  return lines.join('\n');
};

const setProductQuantity = async ({
  conversationId,
  productId,
  quantity
}: {
  conversationId: string;
  productId: string;
  quantity: number;
}) => {

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      business: { select: { id: true } },
      customer: { select: { phone_number: true } }
    }
  });

  if (!conversation) {
    throw new Error('Conversación no encontrada');
  }

  const draftOrder = await prisma.draft_order.findFirst({
    where: {
      business_id: conversation.business.id,
      customer_phone: conversation.customer.phone_number,
      status: 'active'
    }
  });

  if (!draftOrder) {
    throw new Error('No active order found.');
  }

  if (quantity <= 0) {
    await prisma.draft_order_item.deleteMany({
      where: {
        draft_order_id: draftOrder.id,
        product_id: productId
      }
    });
  } else {
    await prisma.draft_order_item.updateMany({
      where: {
        draft_order_id: draftOrder.id,
        product_id: productId
      },
      data: {
        quantity
      }
    });
  }

  // 🔁 Recalcular total
  const items = await prisma.draft_order_item.findMany({
    where: { draft_order_id: draftOrder.id }
  });

  const { total } = computeOrderPricing(items);

  await prisma.draft_order.update({
    where: { id: draftOrder.id },
    data: { total_amount: total }
  });

  return true;
};
