/**
 * Intercepta, ANTES del grafo principal, el tap del cliente en la tarjeta de
 * confirmación admin-initiated (`ADMIN_CONFIRM_ORDER`/`ADMIN_CANCEL_ORDER`,
 * ver `adminDraftOrder.service.ts#requestAdminDraftOrderConfirmation`).
 *
 * Por qué acá y no en el registro de intents del bot (`payloadMapper.ts` /
 * `handlers/index.ts`): cuando `conversation_state.is_human_handled` es
 * `true` (el estado en el que vive toda esta feature), `buildDetectionContextNode`
 * (`src/graph/nodes/context/index.ts`) corta el turno ANTES de leer ningún
 * `payloadId` (`earlyExit: 'bot_disabled_or_human_handled'`) — un botón
 * nuevo metido en el registro normal nunca llegaría a ejecutarse. Este
 * servicio se llama desde `src/index.ts` ANTES de invocar el grafo, así que
 * nunca depende de ese gate.
 */

import { prisma } from '../lib/prisma';
import { WhatsAppWebhookPayload } from '../controllers/webhook/types';
import { extractPayloadId } from '../controllers/webhook/utils';
import {
  findBusinessByPhoneNumberId,
  findOrCreateCustomer,
  createOrGetOpenConversation,
  findOrCreateConversationState,
} from '../repositories';
import {
  omitConversationMetadataKeys,
} from '../repositories/conversationState.repository';
import { createConversationMessage } from '../repositories/conversationMessage.repository';
import { createOrderFromDraft, PromotionChangedError } from './checkout.service';
import { setConversationHumanHandled } from './conversationHumanHandled.service';
import { formatBotUserMessage } from './productQuery/utils';
import { WhatsAppSenderService } from './whatsappSender.service';
import { isPaymentMethodId } from '../domain/payment/paymentMethods';

const CONFIRM_PAYLOAD = 'ADMIN_CONFIRM_ORDER';
const CANCEL_PAYLOAD = 'ADMIN_CANCEL_ORDER';

function asMetadataRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function sendPlainMessage(
  conversationId: string,
  phoneNumberId: string,
  customerPhone: string,
  text: string
): Promise<void> {
  const sender = new WhatsAppSenderService();
  try {
    await sender.sendTextMessage({ phoneNumberId, to: customerPhone, message: text });
  } catch (error) {
    console.error('[AdminOrderConfirmationWebhook] Error al enviar WhatsApp:', error);
  }
  await createConversationMessage(conversationId, 'ai', text, false);
}

/**
 * @returns `true` si el payload era uno de los nuestros (manejado acá, no
 * debe pasar al grafo). `false` si no nos corresponde — seguir el flujo normal.
 */
export async function handleAdminOrderConfirmationWebhook(
  payload: WhatsAppWebhookPayload
): Promise<boolean> {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;
  if (!phoneNumberId || !from || !message) return false;

  const payloadId = extractPayloadId(message);
  if (payloadId !== CONFIRM_PAYLOAD && payloadId !== CANCEL_PAYLOAD) return false;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return true;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  const state = await findOrCreateConversationState(conversation.id);
  const metadata = asMetadataRecord(state.metadata);

  if (metadata.pendingAction !== CONFIRM_PAYLOAD) {
    await sendPlainMessage(
      conversation.id,
      phoneNumberId,
      customer.phone_number,
      formatBotUserMessage(
        'Sin pedido pendiente',
        'ℹ️',
        'Ya no hay nada pendiente de confirmar. Si necesitás algo más, contanos.'
      )
    );
    return true;
  }

  if (payloadId === CANCEL_PAYLOAD) {
    await omitConversationMetadataKeys(conversation.id, ['pendingAction', 'pendingAdminCheckout']);
    await sendPlainMessage(
      conversation.id,
      phoneNumberId,
      customer.phone_number,
      formatBotUserMessage(
        'Pedido no confirmado',
        '👍',
        'Entendido, seguimos coordinando tu pedido con nuestro equipo.'
      )
    );
    return true;
  }

  // CONFIRM_PAYLOAD
  const pending = asMetadataRecord(metadata.pendingAdminCheckout);
  const paymentMethod = pending.paymentMethod;
  const expectedPromotionSignature = pending.expectedPromotionSignature;
  if (typeof paymentMethod !== 'string' || !isPaymentMethodId(paymentMethod)) {
    await omitConversationMetadataKeys(conversation.id, ['pendingAction', 'pendingAdminCheckout']);
    await sendPlainMessage(
      conversation.id,
      phoneNumberId,
      customer.phone_number,
      formatBotUserMessage(
        'No se pudo confirmar',
        '⚠️',
        'Hubo un problema al confirmar tu pedido. Pedile al local que te reenvíe el resumen.'
      )
    );
    return true;
  }

  try {
    const result = await createOrderFromDraft(business, conversation, customer, {
      paymentMethod,
      expectedPromotionSignature:
        typeof expectedPromotionSignature === 'string' ? expectedPromotionSignature : undefined,
    });
    await omitConversationMetadataKeys(conversation.id, ['pendingAction', 'pendingAdminCheckout']);
    await sendPlainMessage(
      conversation.id,
      phoneNumberId,
      customer.phone_number,
      formatBotUserMessage(
        'Pedido confirmado',
        '✅',
        `Número: #${result.orderId}\nTotal: $${result.total.toFixed(2)}\n\n¡Gracias por tu compra!`
      )
    );
    // La gestión puntual del admin terminó: vuelve el bot solo (mismo
    // mecanismo que el timeout) en vez de dejar al cliente "hablándole a
    // nadie" en modo humano. Si cancela en vez de confirmar, se queda en modo
    // humano porque seguramente el admin todavía tiene algo que resolver.
    await setConversationHumanHandled({
      conversationId: conversation.id,
      businessId: business.id,
      humanHandled: false,
      reason: 'order_confirmed',
    });
  } catch (error) {
    await omitConversationMetadataKeys(conversation.id, ['pendingAction', 'pendingAdminCheckout']);
    if (error instanceof PromotionChangedError) {
      await sendPlainMessage(
        conversation.id,
        phoneNumberId,
        customer.phone_number,
        formatBotUserMessage(
          'Los precios cambiaron',
          '⚠️',
          'Los precios de tu pedido cambiaron desde que te mandamos el resumen. Pedile al local que te lo reenvíe para confirmar de nuevo.'
        )
      );
      return true;
    }
    if (error instanceof Error && error.message === 'empty_cart') {
      await sendPlainMessage(
        conversation.id,
        phoneNumberId,
        customer.phone_number,
        formatBotUserMessage(
          'Pedido no disponible',
          'ℹ️',
          'Tu pedido ya no está disponible. Contactá al local si necesitás ayuda.'
        )
      );
      return true;
    }
    console.error('[AdminOrderConfirmationWebhook] Error al crear la orden:', error);
    await sendPlainMessage(
      conversation.id,
      phoneNumberId,
      customer.phone_number,
      formatBotUserMessage(
        'No se pudo confirmar',
        '⚠️',
        'Hubo un problema al confirmar tu pedido. Contactá al local para resolverlo.'
      )
    );
  }

  return true;
}
