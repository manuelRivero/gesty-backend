import { prisma } from '../../../lib/prisma';
import { patchConversationMetadata } from '../../../repositories/conversationState.repository';
import {
  ADDRESS_OUT_OF_COVERAGE_BOT_MESSAGE,
  ADDRESS_REQUIRED_BOT_MESSAGE,
  ADDRESS_SOFT_ASK_BOT_MESSAGE,
} from '../../../services/productQuery/botMessages';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import { detectIntentFromPayload } from '../../../controllers/webhook/payloadMapper';
import { ConversationIntent } from '../../../types/conversationIntent';
import type { HandlerFollowUp } from '../../../controllers/webhook/types';
import type { AgentState, AgentStateUpdate } from '../../state';

/**
 * Intents que requieren dirección para continuar.
 * Agregar producto al carrito, ver carrito o finalizar pedido sin dirección → bloqueante.
 */
/**
 * Ventana de re-sugerencia del soft-ask (H-06): pasado este tiempo desde la
 * última sugerencia, se puede volver a mostrar. No es una capturante — nunca
 * rutea, solo evita repetir el mensaje en cada turno.
 */
export const ADDRESS_SOFT_ASK_TTL_MS = 60 * 60 * 1000;

export const CART_BLOCKING_INTENTS = new Set<string>([
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
 * - Si el cliente tiene dirección y está en cobertura, pasa de largo.
 * - Si la ruta activa no es interactive/nlp (reserva, onboarding, address_capture),
 *   pasa de largo — esos flujos se manejan solos.
 * - Sin dirección o fuera de cobertura + intent de carrito/pedido: REEMPLAZA el
 *   `handlerResult` (bloqueante).
 * - Sin dirección + otro intent: agrega follow-up no bloqueante (solo una vez).
 */
export const addressCollectionNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  if (state.skipAIPersistence) return {};
  if (state.dataCollectionDelegated) return {};  // agente gestiona dirección via save_delivery_address
  if (state.contextRoute !== 'interactive' && state.contextRoute !== 'nlp') return {};

  // Si el tipo de entrega ya es TAKE_AWAY no se necesita dirección
  const business = state.business;
  const phone = state.webhookContext?.to ?? '';
  if (business && phone) {
    const draft = await prisma.draft_order.findFirst({
      where: { business_id: business.id, customer_phone: phone, status: 'active' },
      select: { fulfillment_type: true }
    });
    if (draft?.fulfillment_type === 'TAKE_AWAY') return {};
  }

  const needsAddress = !state.hasAddress;
  const outOfCoverage = state.hasAddress && !state.isInCoverage;

  if (!needsAddress && !outOfCoverage) return {};

  const conversation = state.conversation!;
  const meta = normalizeMetadata(state.workingConversationState?.metadata);

  const intentFromDetection = state.detection?.intent as string | undefined;
  const intentFromPayload = state.webhookContext?.payloadId
    ? detectIntentFromPayload(state.webhookContext.payloadId)?.intent
    : undefined;
  const currentIntent = intentFromDetection ?? intentFromPayload ?? null;

  const isCartIntent = currentIntent !== null && CART_BLOCKING_INTENTS.has(currentIntent);

  if (isCartIntent) {
    if (!meta.awaiting_address) {
      await patchConversationMetadata(conversation.id, {
        awaiting_address: true,
        pending_address_action: currentIntent ?? null,
      });
    }

    const content = outOfCoverage
      ? ADDRESS_OUT_OF_COVERAGE_BOT_MESSAGE
      : ADDRESS_REQUIRED_BOT_MESSAGE;

    return { handlerResult: { content, isInteractive: false } };
  }

  // No bloqueante: solo cuando no hay dirección (fuera de cobertura se informa al agregar al carrito).
  // NUNCA setea `awaiting_address` (H-06): es una sugerencia informativa, no una
  // captura activa — no debe rutear los próximos mensajes de texto hacia onboarding.
  const softAskedAt = meta.address_soft_asked ? new Date(meta.address_soft_asked).getTime() : null;
  const softAskExpired = softAskedAt === null || Date.now() - softAskedAt >= ADDRESS_SOFT_ASK_TTL_MS;
  if (needsAddress && !meta.awaiting_address && softAskExpired && state.handlerResult) {
    await patchConversationMetadata(conversation.id, {
      address_soft_asked: new Date().toISOString(),
    });
    const ask: HandlerFollowUp = {
      type: 'text',
      message: ADDRESS_SOFT_ASK_BOT_MESSAGE,
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
