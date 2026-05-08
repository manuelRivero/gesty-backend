import { patchConversationMetadata } from '../../../repositories/conversationState.repository';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import { detectIntentFromPayload } from '../../../controllers/webhook/payloadMapper';
import { ConversationIntent } from '../../../types/conversationIntent';
import type { HandlerFollowUp, HandlerResult } from '../../../controllers/webhook/types';
import type { AgentState, AgentStateUpdate } from '../../state';

/**
 * Intents que requieren dirección para continuar.
 * Agregar producto al carrito, ver carrito o finalizar pedido sin dirección → bloqueante.
 */
const CART_BLOCKING_INTENTS = new Set<string>([
  ConversationIntent.ADD_ITEM,
  ConversationIntent.ADD_PRODUCT,
  ConversationIntent.CONFIRM_ADD,
  ConversationIntent.ORDER_FOOD,
  ConversationIntent.SELECT_ORDER_PRODUCT,
  ConversationIntent.VIEW_CART,
  ConversationIntent.VIEW_CART_FOR_EDITION,
  ConversationIntent.CHECKOUT,
]);

/**
 * Nodo post-handler que gestiona la captura de dirección de entrega.
 *
 * - Si el cliente ya tiene dirección registrada (`hasAddress`), pasa de largo.
 * - Si la ruta activa no es interactive/nlp (reserva, onboarding, address_capture),
 *   pasa de largo — esos flujos se manejan solos.
 * - Si el intent es de carrito/pedido: REEMPLAZA el `handlerResult` con una
 *   solicitud de dirección (bloqueante) y activa `awaiting_address`.
 * - Cualquier otro intent: agrega la solicitud como follow-up (no bloqueante),
 *   solo la primera vez.
 */
export const addressCollectionNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  if (state.skipAIPersistence) return {};
  if (state.hasAddress) return {};
  if (state.contextRoute !== 'interactive' && state.contextRoute !== 'nlp') return {};

  const conversation = state.conversation!;
  const meta = normalizeMetadata(state.workingConversationState?.metadata);

  // Determinar el intent actual: NLP lo deja en state.detection, interactive en payloadId
  const intentFromDetection = state.detection?.intent as string | undefined;
  const intentFromPayload = state.webhookContext?.payloadId
    ? detectIntentFromPayload(state.webhookContext.payloadId)?.intent
    : undefined;
  const currentIntent = intentFromDetection ?? intentFromPayload ?? null;

  const isCartIntent = currentIntent !== null && CART_BLOCKING_INTENTS.has(currentIntent);

  if (isCartIntent) {
    if (!meta.awaiting_address) {
      await patchConversationMetadata(conversation.id, { awaiting_address: true });
    }
    const addressRequest: HandlerResult = {
      content:
        'Para continuar con tu pedido necesito tu dirección de entrega. 📍\n\nIndicame la calle y número o compartí tu ubicación.',
      isInteractive: false,
    };
    return { handlerResult: addressRequest };
  }

  // No bloqueante: agregar follow-up solo la primera vez
  if (!meta.awaiting_address && state.handlerResult) {
    await patchConversationMetadata(conversation.id, { awaiting_address: true });
    const ask: HandlerFollowUp = {
      type: 'text',
      message:
        'Por cierto, para poder procesar pedidos necesito tu dirección de entrega. ¿Me la podés indicar o compartir tu ubicación? 📍',
    };
    return {
      handlerResult: {
        ...state.handlerResult,
        followUps: [...(state.handlerResult.followUps ?? []), ask],
      },
    };
  }

  return {};
};
