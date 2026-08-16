/**
 * Gates y subflujos tempranos del grafo principal.
 *
 * Cada función replica un bloque concreto de `processWebhook`:
 * - `closedBusinessNode`: persiste mensaje en conversación cerrada y prepara
 *   el aviso de cierre (`processInboundWhileBusinessClosed`).
 * - `subscriptionAccessGateNode`: evalúa la suscripción/trial; bloquea con
 *   mensaje si no aplica.
 * - `reservationWizardNode`: `processReservationWizardIfActive`.
 *
 * El onboarding no tiene nodo acá: lo maneja `onboardingAgentNode` en todo
 * turno que Ownership le asigne (el wizard legacy por `onboarding_step` y su
 * clasificador de intent se borraron).
 *
 * Todos los nodos se limitan a producir un parche del estado: el envío real
 * de WhatsApp y la persistencia del mensaje AI lo hace `sendResponseNode` +
 * `persistAIMessageNode` corriente abajo.
 */

import {
  createConversationMessage,
  createClosedConversationForOffHoursInbound,
  findLatestClosedConversationByCustomer,
  updateConversationLastMessageAt,
} from '../../../repositories';
import { evaluateSubscriptionForBotAi } from '../../../services/subscriptionBotAccess.service';
import {
  formatClosedBusinessCustomerNotice,
} from '../../../services/businessHours.service';
import { handleReservationIntent } from '../../../services/reservations';
import { reservationStepQuestion } from '../../../services/reservations/reservation.service';
import { classifyReservationTurn } from '../../../services/reservations/turnClassifier.service';
import { normalizeToHandlerResult } from '../../../controllers/webhook/utils';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import { patchConversationMetadata } from '../../../repositories/conversationState.repository';
import { formatInboundMessageForLog } from '../../../controllers/webhook/utils/messageLog';
import type { EnrichedContext } from '../../../controllers/webhook/types';
import type { AgentState, AgentStateUpdate } from '../../state';
import type { ReservationState } from '../../../services/reservations/types';

/** Nodo para `businessStatus.isOpen === false`. */
export const closedBusinessNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const business = state.business!;
  const customer = state.customer!;
  const businessStatus = state.businessStatus!;

  const closedConversation = await findLatestClosedConversationByCustomer(
    customer.id,
    business.id
  );
  const conversationId = closedConversation?.id;
  const message = ctx.message;
  const messageContent = formatInboundMessageForLog(message);

  if (conversationId) {
    await createConversationMessage(
      conversationId,
      'user',
      messageContent,
      false,
      message?.id
    );
  } else {
    const created = await createClosedConversationForOffHoursInbound(
      business.id,
      customer.id
    );
    await createConversationMessage(
      created.id,
      'user',
      messageContent,
      false,
      message?.id
    );
  }

  const timezone = business.timezone?.trim();
  if (!timezone) {
    console.warn(
      '[Orchestrator] Negocio sin timezone; no se envía aviso de cierre al cliente'
    );
    return {};
  }

  const closedNotice = formatClosedBusinessCustomerNotice(
    businessStatus.nextOpenText
  );

  return {
    handlerResult: { content: closedNotice, isInteractive: false },
    skipAIPersistence: true,
  };
};

/** Nodo de gate de suscripción/trial. */
export const subscriptionAccessGateNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const business = state.business!;
  const subscriptionAccess = await evaluateSubscriptionForBotAi(business);
  if (subscriptionAccess.ok) {
    return { business: subscriptionAccess.business };
  }
  return {
    handlerResult: {
      content: subscriptionAccess.message,
      isInteractive: false,
    },
    earlyExit: 'subscription_blocked',
  };
};

/**
 * @deprecated Nodo del wizard LEGACY de reservas (por steps). Reemplazado por
 * el agente de reservas (`reservationAgentNode`, `src/graph/nodes/reservation/index.ts`).
 * Con `RESERVATION_AGENT_ENABLED=true` este nodo solo procesa sesiones con
 * `reservation.step` ya en curso desde antes; no recibe sesiones nuevas
 * (el routing en `context/index.ts`/`dispatch/index.ts` las manda al agente).
 * Queda como fallback completo si el flag se apaga. No agregar features acá.
 *
 * Si `conversationState.metadata.reservation.step` está activo, clasifica el
 * turno y decide si ejecutar el handler (FULFILL_STEP) o pausar la reserva y
 * encadenar al flujo normal (DELEGATE).
 */
export const reservationWizardNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const enrichedBase = state.enrichedCtx as unknown as EnrichedContext;
  const ctx = state.webhookContext!;
  const conversation = state.conversation!;
  const meta = normalizeMetadata(state.workingConversationState?.metadata);
  const reservation = meta.reservation as ReservationState | undefined;

  if (reservation?.step) {
    const userMessage = ctx.message?.text?.body ?? '';
    const classification = await classifyReservationTurn({
      step: reservation.step,
      botQuestion: reservationStepQuestion(reservation.step),
      userMessage,
      payloadId: ctx.payloadId,
    });

    console.log('[reservation-turn]', {
      step: reservation.step,
      action: classification.action,
      source: classification.source,
      confidence: classification.confidence,
      conversationId: conversation.id,
    });

    if (classification.action === 'DELEGATE') {
      await patchConversationMetadata(conversation.id, {
        reservation: { ...reservation, paused: true },
      });
      const route: 'nlp' | 'interactive' =
        ctx.message?.type === 'interactive' ? 'interactive' : 'nlp';
      return { reservationDelegateRoute: route };
    }
  }

  // FULFILL_STEP → handler normal.
  const reservationResult = await handleReservationIntent(enrichedBase);
  if (!reservationResult) {
    return { earlyExit: 'reservation_handled' };
  }
  const handlerResult = normalizeToHandlerResult(reservationResult);
  return { handlerResult, earlyExit: 'reservation_handled' };
};

export { updateConversationLastMessageAt }; // re-export para nodos send/persist
