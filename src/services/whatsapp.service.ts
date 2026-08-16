/**
 * Funciones vivas del webhook que aún viven en este archivo:
 * selección de producto / pedido (listas WhatsApp) y verificación del webhook.
 *
 * El pipeline NLP (`processIncomingMessage` + `detectIntentWithConfidence`) se
 * borró: el grafo (`mainGraph`) es el único camino de prosa.
 */

import {
  WhatsAppWebhookPayload
} from '../types/whatsapp';
import {
  createOrGetOpenConversation,
  createConversationMessage,
  findBusinessByPhoneNumberId,
  findOrCreateConversationState,
  updateConversationState,
  findOrCreateCustomer,
  updateConversationLastMessageAt
} from '../repositories';
import {
  generateOrderExtraction,
  generateProductAwareResponse
} from './ai/openai.service';
import { computeCartTotalDecimal } from './pricing.service';
import { resolveEffectivePrice } from '../helpers/menuItemPrice.helper';
import type { WhatsAppInteractiveMessage, WhatsAppListMessage } from '../domain/intent/whatsappTemplates';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import {
  clearProductFilterMetadata,
  formatBotUserMessage,
  getRequestedPartySize,
  parseSelectProductListRowId,
} from './productQuery/utils';
import { persistLastOffer } from './lastOffer.service';

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

const buildMetadataValue = (
  metadata: ConversationMetadata
): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput => {
  return Object.keys(metadata).length === 0
    ? Prisma.JsonNull
    : (metadata as Prisma.InputJsonValue);
};

function servingDoesNotMeetRequestedPeople(
  requested: number | null | undefined,
  servesPeople: number | null
): boolean {
  if (requested == null || requested < 2) return false;
  if (servesPeople == null || servesPeople < 1) return true;
  return servesPeople < requested;
}

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
      image: true,
      variations: true,
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
        ? '- Es importante: aclarar en tu respuesta que una sola unidad puede no alcanzar para todos. NO digas que va a sumar N unidades ni inventes botones "Agregar N": al tocar Agregar el sistema preguntará cuántas quiere.'
        : '- Si la ficha alcanza para lo pedido, podés confirmarlo brevemente.'
    }`;
  }

  let aiResponse: string;
  try {
    aiResponse = await generateProductAwareResponse({
      businessId: business.id,
      product: {
        name: item.name,
        description: item.description,
        ingredients: item.ingredients,
        serves_people: item.serves_people,
        is_available: item.is_available,
        variations: item.variations?.length ? item.variations : null,
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
  } catch (err) {
    // Sin fallback el turno queda en silencio (usuario manda "?" / "hola?" sin respuesta).
    console.error('[product-selection] generateProductAwareResponse failed:', err);
    const priceLabel = `${Number(activePrice.amount).toLocaleString('es-AR')} ${activePrice.currency_code}`;
    const variationsHint =
      item.variations?.length
        ? `\n\nVariedades: ${item.variations.join(', ')}. Decime cuál preferís al sumarlo.`
        : '';
    aiResponse = formatBotUserMessage(
      item.name,
      '🍽️',
      `${item.description?.trim() || 'Buenisima elección.'}\n\n*Precio:* ${priceLabel}${variationsHint}\n\nSi querés, sumalo al pedido con el botón de abajo.`
    );
  }

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

  // Persistir después del updateConversationState para que el patch no sea sobreescrito.
  await persistLastOffer({
    conversationId: conversation.id,
    productId: item.id,
    productName: item.name,
    suggestedQuantity: listSuggestedQuantity ?? 1,
    source: 'product_query',
  });

  const header = item.image
    ? ({ type: 'image', image: { link: item.image } } as const)
    : ({ type: 'text', text: 'Tenemos un match para tu consulta' } as const);

  // Un solo CTA de intención de sumar (sin qty). Si party sugiere ≥2,
  // AddItemHandler abre pendingAddQuantity en lugar de botones Agregar N.
  void listSuggestedQuantity;
  void servesMismatch;
  const buttons: Array<{
    type: 'reply';
    reply: { id: string; title: string };
  }> = [
    {
      type: 'reply',
      reply: { id: `ADD_ITEM:${item.id}`, title: 'Agregar' },
    },
    {
      type: 'reply',
      reply: { id: 'VIEW_MENU', title: 'Ver menú' },
    },
  ];

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

