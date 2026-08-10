// services/orderService.ts
import { Prisma, OrderStatus, business, conversation, customer, draft_order } from '@prisma/client';
import { emitAdminOrderStatusChanged } from '../socket/adminSocket';
import { prisma } from '../lib/prisma';
import {
  findBusinessByPhoneNumberId,
  findOrCreateCustomer,
  createOrGetOpenConversation,
  findOrCreateConversationState,
  createConversationMessage,
  updateConversationLastMessageAt,
  patchConversationMetadata,
  omitConversationMetadataKeys,
} from '../repositories';
import { refreshDraftOrderTimeout } from './draftOrderTimeout.service';
import { buildOrderSearchListMessage } from '../whatsappBuilders'; // Tu ruta: root/whatsappBuilders
import { normalizeMetadata } from './utils'; // Ajusta ruta si es diferente
import type { WhatsAppWebhookPayload } from '../types/whatsapp'; // Ajusta ruta
import type {
  WhatsAppInteractiveMessage,
  WhatsAppListMessage,
} from '../domain/intent/whatsappTemplates';
import { formatBotUserMessage } from './productQuery/utils';
import { clearOrderSessionAfterCancel } from './orderSessionReset.service';
import { shortOrderRef } from './orderStatusNotification.service';

export const handleOrderSearchPageFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  page: number
): Promise<string | WhatsAppListMessage | null> => {

  // Extracción mínima necesaria para este servicio
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  // Error silencioso 1: Payload estructuralmente inválido
  if (!phoneNumberId || !from) {
    console.warn('[OrderSearch] Payload sin phoneNumberId o from', { phoneNumberId, from });
    return null;
  }

  // Error silencioso 2: Business no encontrado
  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) {
    console.error('[OrderSearch] Business no encontrado para phoneNumberId:', phoneNumberId);
    // Opcional: await notifyAdmin(`Business missing: ${phoneNumberId}`);
    return null;
  }

  // Lógica de negocio (sin cambios)
  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  const conversationState = await findOrCreateConversationState(conversation.id);
  const metadata = normalizeMetadata(conversationState.metadata);

  // Validación de metadata (mensaje visible al usuario)
  if (!metadata.pendingOrderSelection || !metadata.pendingOrderCandidateIds?.length) {
    return 'Esa opción ya no está disponible. Por favor realiza una nueva consulta.';
  }

  // Query a Prisma (sin cambios)
  const items = await prisma.menu_item.findMany({
    where: { id: { in: metadata.pendingOrderCandidateIds } },
    select: { id: true, name: true, description: true, ingredients: true }
  });

  const itemMap = new Map(items.map((item) => [item.id, item]));
  const orderedItems = metadata.pendingOrderCandidateIds
    .map((id) => itemMap.get(id))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  // Builder (ya movido a tu infraestructura)
  const listMessage = buildOrderSearchListMessage({
    items: orderedItems,
    page
  });

  // Side effects de persistencia (sin cambios)
  await createConversationMessage(conversation.id, 'ai', listMessage.body.text, false);
  await updateConversationLastMessageAt(conversation.id);

  return listMessage;
};

// services/orderService.ts — cancelación draft vs orden creada

/** Órdenes ya creadas que el cliente aún puede cancelar (previo a entregado). */
export const CLIENT_CANCELLABLE_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.placed,
  OrderStatus.preparing,
  OrderStatus.ready_for_pickup,
  OrderStatus.shipped,
];

export type CancelOrderTarget = 'draft' | 'order';

export type CancelOrderResult = string | WhatsAppInteractiveMessage;

const resolveCancelTargetFromPayload = (
  payloadId: string | undefined
): CancelOrderTarget | undefined => {
  if (payloadId === 'CANCEL_TARGET:draft') return 'draft';
  if (payloadId === 'CANCEL_TARGET:order') return 'order';
  return undefined;
};

async function findClientCancellableOrder(conversationId: string) {
  return prisma.orders.findFirst({
    where: {
      conversation_id: conversationId,
      status: { in: CLIENT_CANCELLABLE_ORDER_STATUSES },
    },
    orderBy: { created_at: 'desc' },
  });
}

async function findActiveDraft(businessId: string, customerPhone: string) {
  return prisma.draft_order.findFirst({
    where: {
      business_id: businessId,
      customer_phone: customerPhone,
      status: 'active',
    },
  });
}

async function cancelActiveDraft(draftOrderId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.draft_order_item.deleteMany({
      where: { draft_order_id: draftOrderId },
    });
    await tx.draft_order.update({
      where: { id: draftOrderId },
      data: {
        status: 'cancelled',
        total_amount: new Prisma.Decimal(0),
      },
    });
  });
}

async function cancelPlacedOrderAndNotifyAdmin(order: {
  id: string;
  business_id: string;
}): Promise<void> {
  await prisma.orders.update({
    where: { id: order.id },
    data: { status: OrderStatus.cancelled },
  });

  const orderRef = shortOrderRef(order.id);
  emitAdminOrderStatusChanged(order.business_id, {
    orderId: order.id,
    status: OrderStatus.cancelled,
    orderRef,
    message: `El cliente canceló el pedido #${orderRef}`,
  });
}

function buildCancelDisambiguationMessage(orderRef: string): WhatsAppInteractiveMessage {
  const body = formatBotUserMessage(
    '¿Qué cancelamos?',
    '❓',
    [
      'Tenés un *carrito en armado* y también un *pedido ya confirmado*.',
      '',
      `• *Carrito* — borra lo que estás armando`,
      `• *Pedido* #${orderRef} — cancela el pedido ya creado`,
      '',
      'O elegí con los botones 👇',
    ].join('\n')
  );

  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '¿Qué cancelamos?' },
      body: { text: body },
      footer: { text: 'Elegí una opción' },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: 'CANCEL_TARGET:draft', title: 'Carrito' },
          },
          {
            type: 'reply',
            reply: { id: 'CANCEL_TARGET:order', title: `Pedido #${orderRef.slice(0, 8)}` },
          },
        ],
      },
    },
  };
}

/**
 * Cancela draft y/o orden creada según reglas:
 * - solo draft → cancela draft
 * - solo orden cancelable → cancela orden + notifica admin
 * - ambos sin target → desambigua (botones)
 * - ambos con target → cancela solo ese
 */
export const buildCancelOrderMessage = async (
  conversation: conversation,
  businessId: string,
  customerPhone: string,
  options?: {
    target?: CancelOrderTarget;
    /** Payload interactivo (CANCEL_ORDER | CANCEL_TARGET:draft | CANCEL_TARGET:order). */
    payloadId?: string;
  }
): Promise<CancelOrderResult | null> => {
  const target =
    options?.target ?? resolveCancelTargetFromPayload(options?.payloadId);

  const pendingOrder = await findClientCancellableOrder(conversation.id);
  const draftOrder = await findActiveDraft(businessId, customerPhone);

  if (!pendingOrder && !draftOrder) {
    await omitConversationMetadataKeys(conversation.id, ['pending_cancel_disambiguation']);
    const errorText = formatBotUserMessage(
      'Nada para cancelar',
      'ℹ️',
      'No tenés un pedido en curso para cancelar. Cuando quieras, pedime el menú y armamos uno nuevo.'
    );
    await createConversationMessage(conversation.id, 'ai', errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return errorText;
  }

  // Ambos vivos y sin elección → preguntar
  if (pendingOrder && draftOrder && !target) {
    const orderRef = shortOrderRef(pendingOrder.id);
    await patchConversationMetadata(conversation.id, {
      pending_cancel_disambiguation: {
        orderId: pendingOrder.id,
        orderRef,
        askedAt: new Date().toISOString(),
      },
    });
    const msg = buildCancelDisambiguationMessage(orderRef);
    await createConversationMessage(conversation.id, 'ai', msg.interactive.body.text, true);
    await updateConversationLastMessageAt(conversation.id);
    return msg;
  }

  const cancelDraft = Boolean(draftOrder && (!pendingOrder || target === 'draft'));
  const cancelOrder = Boolean(pendingOrder && (!draftOrder || target === 'order'));

  if (target === 'draft' && !draftOrder) {
    const errorText = formatBotUserMessage(
      'Sin carrito',
      'ℹ️',
      'No hay un carrito activo para cancelar.'
    );
    await createConversationMessage(conversation.id, 'ai', errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return errorText;
  }

  if (target === 'order' && !pendingOrder) {
    const errorText = formatBotUserMessage(
      'Sin pedido confirmado',
      'ℹ️',
      'No hay un pedido ya creado que se pueda cancelar ahora.'
    );
    await createConversationMessage(conversation.id, 'ai', errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return errorText;
  }

  if (cancelDraft && draftOrder) {
    await cancelActiveDraft(draftOrder.id);
    await clearOrderSessionAfterCancel(conversation.id);
  }

  if (cancelOrder && pendingOrder) {
    await cancelPlacedOrderAndNotifyAdmin(pendingOrder);
    if (!cancelDraft) {
      await omitConversationMetadataKeys(conversation.id, ['pending_cancel_disambiguation']);
    }
  } else {
    await omitConversationMetadataKeys(conversation.id, ['pending_cancel_disambiguation']);
  }

  const messageText = formatBotUserMessage(
    'Pedido cancelado',
    '❌',
    cancelOrder && !cancelDraft
      ? 'Tu pedido confirmado fue cancelado. Cuando quieras, armamos uno nuevo.'
      : cancelDraft && !cancelOrder
        ? 'Tu carrito fue cancelado. Cuando quieras, armamos uno nuevo.'
        : 'Tu pedido fue cancelado. Cuando quieras, armamos uno nuevo.'
  );
  await createConversationMessage(conversation.id, 'ai', messageText, false);
  await updateConversationLastMessageAt(conversation.id);

  return messageText;
};

export const handleCancelOrderFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  payloadId?: string
): Promise<CancelOrderResult | null> => {

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

  return await buildCancelOrderMessage(conversation, business.id, customer.phone_number, {
    payloadId: payloadId ?? 'CANCEL_ORDER',
  });
};

export const handleDraftOrder = async (
  business: business,
  customer: customer
) => {

  let draftOrder = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: customer.phone_number,
      status: 'active'
    }
  });
  if (!draftOrder) {
    draftOrder = await prisma.draft_order.create({
      data: {
        business_id: business.id,
        customer_phone: customer.phone_number,
        status: 'active',
        currency: business.currency_code ?? 'ARS'
      }
    });
    // Inicialización (no renovación): fija el primer expires_at del draft
    // recién creado. La renovación por actividad del usuario la maneja
    // exclusivamente touchSession (src/services/sessionActivity.service.ts).
    await refreshDraftOrderTimeout(draftOrder.id);
  }
  return draftOrder;
}

export const handleDraftOrderItem = async (
  draftOrder: draft_order,
  itemID: string
) => {
  return await prisma.draft_order_item.findFirst({
    where: {
      draft_order_id: draftOrder.id,
      menu_item: {
        id: itemID
      }
    },
    include: {
      menu_item: true
    }
  });
}

// REFACTORIZADO: handleOrderSearchPageFromWebhook ya no existe
// Su lógica se dividió en:
// 1. searchOrderProducts (servicio puro) ← acá
// 2. buildOrderSearchListMessage (builder) ← en whatsappBuilders
// 3. OrderSearchPageHandler (orquesta) ← en webhooks/handlers