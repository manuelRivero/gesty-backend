// services/orderService.ts
import { emitAdminOrderStatusChanged } from '../socket/adminSocket';
import { prisma } from '../lib/prisma';
import {
  findBusinessByPhoneNumberId,
  findOrCreateCustomer,
  createOrGetOpenConversation,
  findOrCreateConversationState,
  createConversationMessage,
  updateConversationLastMessageAt
} from '../repositories';
import { buildOrderSearchListMessage } from '../whatsappBuilders'; // Tu ruta: root/whatsappBuilders
import { normalizeMetadata } from './utils'; // Ajusta ruta si es diferente
import type { WhatsAppWebhookPayload } from '../types/whatsapp'; // Ajusta ruta
import { WhatsAppListMessage } from '../domain/intent/whatsappTemplates';
import { OrderStatus, business, conversation, customer } from '@prisma/client';
import { draft_order } from '@prisma/client';

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

// services/orderService.ts

export const buildCancelOrderMessage = async (
  conversation: conversation
): Promise<string | null> => {

  const pendingOrder = await prisma.orders.findFirst({
    where: {
      conversation_id: conversation.id,
      status: {
        in: [OrderStatus.placed, OrderStatus.preparing]
      }
    }
  });

  if (!pendingOrder) {
    const errorText = 'No tenés pedidos pendientes para cancelar.';
    await createConversationMessage(conversation.id, 'ai', errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return errorText;
  }

  await prisma.orders.update({
    where: { id: pendingOrder.id },
    data: { status: OrderStatus.cancelled }
  });

  emitAdminOrderStatusChanged(pendingOrder.business_id, {
    orderId: pendingOrder.id,
    status: OrderStatus.cancelled
  });

  const messageText = `❌ Pedido #${pendingOrder.id} cancelado correctamente.`;
  await createConversationMessage(conversation.id, 'ai', messageText, false);
  await updateConversationLastMessageAt(conversation.id);

  return messageText;
};

export const handleCancelOrderFromWebhook = async (
  payload: WhatsAppWebhookPayload
): Promise<string | null> => {

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

  return await buildCancelOrderMessage(conversation);
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