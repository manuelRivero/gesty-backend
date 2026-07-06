import { prisma } from '../../../lib/prisma';
import { patchConversationMetadata } from '../../../repositories/conversationState.repository';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import { detectIntentFromPayload } from '../../../controllers/webhook/payloadMapper';
import { isHybridAgentMode } from '../../../config/env';
import { ConversationIntent } from '../../../types/conversationIntent';
import { FULFILLMENT_TYPE_PROMPT_BOT_MESSAGE } from '../../../services/productQuery/botMessages';
import type { WhatsAppInteractiveMessage } from '../../../domain/intent/whatsappTemplates';
import type { AgentState, AgentStateUpdate } from '../../state';

/**
 * Intents de carrito que requieren elegir el tipo de entrega ANTES de
 * que el handler se ejecute. CHECKOUT se excluye porque el handler
 * ya convierte el draft — cuando el gate corra no habrá draft activo.
 */
export const CART_FULFILLMENT_INTENTS = new Set<string>([
  ConversationIntent.ADD_ITEM,
  ConversationIntent.ADD_PRODUCT,
  ConversationIntent.CONFIRM_ADD,
  ConversationIntent.ORDER_FOOD,
  ConversationIntent.SELECT_ORDER_PRODUCT,
  ConversationIntent.VIEW_CART,
  ConversationIntent.VIEW_CART_FOR_EDITION,
]);

export function buildFulfillmentSelectionMessage(): WhatsAppInteractiveMessage {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '' },
      body: {
        text: FULFILLMENT_TYPE_PROMPT_BOT_MESSAGE
      },
      footer: { text: 'Seleccioná una opción' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'FULFILLMENT_DELIVERY', title: 'Envío a domicilio' } },
          { type: 'reply', reply: { id: 'FULFILLMENT_TAKE_AWAY', title: 'Retirar en local' } }
        ]
      }
    }
  };
}

/**
 * Gate legacy de selección de tipo de entrega post-carrito.
 *
 * En modo híbrido el checkout agent gestiona fulfillment al finalizar el pedido;
 * este nodo no intercepta el turno (evita botones de entrega tras ADD_ITEM).
 *
 * En modo determinístico mantiene el comportamiento anterior.
 */
export const fulfillmentSelectionNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  if (isHybridAgentMode()) return {};

  if (state.skipAIPersistence) return {};
  if (state.contextRoute !== 'interactive' && state.contextRoute !== 'nlp') return {};

  const config = state.businessConfig;
  if (!config) return {};

  const deliveryEnabled = config.delivery_enabled;
  const takeawayEnabled = config.takeaway_enabled;

  // Solo delivery habilitado: flujo actual sin cambios
  if (deliveryEnabled && !takeawayEnabled) return {};

  const intentFromDetection = state.detection?.intent as string | undefined;
  const intentFromPayload = state.webhookContext?.payloadId
    ? detectIntentFromPayload(state.webhookContext.payloadId)?.intent
    : undefined;
  const currentIntent = intentFromDetection ?? intentFromPayload ?? null;

  if (!currentIntent || !CART_FULFILLMENT_INTENTS.has(currentIntent)) return {};

  const business = state.business!;
  const phone = state.webhookContext?.to ?? '';

  const draft = await prisma.draft_order.findFirst({
    where: { business_id: business.id, customer_phone: phone, status: 'active' },
    select: { id: true, fulfillment_type: true }
  });

  // Sin draft activo (carrito vacío o ya convertido) → nada que configurar
  if (!draft) return {};

  // Si solo take-away habilitado: setear silenciosamente
  if (!deliveryEnabled && takeawayEnabled) {
    if (!draft.fulfillment_type) {
      await prisma.$executeRaw`
        UPDATE draft_order
        SET fulfillment_type = 'TAKE_AWAY'::"FulfillmentType"
        WHERE id = ${draft.id}::uuid
      `;
    }
    return {};
  }

  // Ambos habilitados: verificar si ya eligió
  if (draft.fulfillment_type) return {};

  // Mostrar selección
  const conversation = state.conversation!;
  const meta = normalizeMetadata(state.workingConversationState?.metadata);

  if (!meta.pending_fulfillment_action) {
    await patchConversationMetadata(conversation.id, {
      pending_fulfillment_action: currentIntent
    });
  }

  return {
    handlerResult: { content: buildFulfillmentSelectionMessage(), isInteractive: true },
    fulfillmentSelectionPending: true
  };
};
