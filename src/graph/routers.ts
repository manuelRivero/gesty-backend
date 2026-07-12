/**
 * Conditional edges del `StateGraph` principal.
 *
 * Cada router es una función pura que recibe el estado actual y devuelve el
 * nombre del siguiente nodo (o `__end__` para terminar). LangGraph los usa en
 * `addConditionalEdges`.
 */

import { END } from '@langchain/langgraph';
import type { AgentState } from './state';

export const NODE = {
  EXTRACT: 'extractContext',
  RESOLVE_BIZ: 'resolveBusiness',
  RESOLVE_BIZ_CONFIG: 'resolveBusinessConfig',
  RESOLVE_CUSTOMER: 'resolveCustomer',
  BIZ_OPEN: 'businessOpenInfo',
  CLOSED_BIZ: 'closedBusiness',
  PERSIST_USER: 'persistUserMessage',
  SUBSCRIPTION_GATE: 'subscriptionAccessGate',
  MESSAGE_TYPE_GUARD: 'messageTypeGuard',
  ESCALATION_GATE: 'escalationGate',
  BUILD_DETECTION_CTX: 'buildDetectionContext',
  RESERVATION: 'reservationWizard',
  RESERVATION_AGENT: 'reservationAgent',
  ONBOARDING_BY_STATE: 'onboardingByState',
  ONBOARDING_AGENT: 'onboardingAgent',
  ADDRESS_CAPTURE: 'addressCapture',
  INTERACTIVE: 'interactiveSubgraph',
  NLP: 'nlpSubgraph',
  CHECKOUT_AGENT: 'checkoutAgent',
  ADDRESS_COLLECTION: 'addressCollection',
  FULFILLMENT_SELECTION: 'fulfillmentSelection',
  NAME_COLLECTION: 'nameCollection',
  SEND: 'sendResponse',
  PERSIST_AI: 'persistAIMessage',
} as const;

export type NodeName = (typeof NODE)[keyof typeof NODE];

/**
 * Tras `extractContext`. Si hay early-exit (status only o invalid payload),
 * termina; si no, continúa a `resolveBusiness`.
 */
export const routeAfterExtract = (state: AgentState): NodeName | typeof END => {
  if (state.earlyExit) return END;
  return NODE.RESOLVE_BIZ;
};

/** Tras `resolveBusiness`. Si no hay business, termina. */
export const routeAfterResolveBusiness = (
  state: AgentState
): NodeName | typeof END => {
  if (state.earlyExit) return END;
  return NODE.RESOLVE_BIZ_CONFIG;
};

/** Tras `businessOpenInfo`: abre o cerrado. */
export const routeAfterBusinessOpen = (
  state: AgentState
): NodeName | typeof END => {
  if (state.earlyExit === 'business_closed') return NODE.CLOSED_BIZ;
  if (state.earlyExit) return END;
  return NODE.PERSIST_USER;
};

/** Tras `persistUserMessage`. */
export const routeAfterPersistUser = (
  state: AgentState
): NodeName | typeof END => {
  if (state.earlyExit) return END;
  return NODE.SUBSCRIPTION_GATE;
};

/** Tras `subscriptionAccessGate`. */
export const routeAfterSubscriptionGate = (
  state: AgentState
): NodeName | typeof END => {
  if (state.earlyExit === 'subscription_blocked') return NODE.SEND;
  if (state.earlyExit) return END;
  return NODE.MESSAGE_TYPE_GUARD;
};

/**
 * Tras `messageTypeGuard`. Si el tipo de mensaje no es soportado, el nodo ya
 * preparó el `HandlerResult` con el aviso amable + reply button: lo enviamos
 * directo. En caso contrario seguimos al constructor de contexto de detección.
 */
export const routeAfterMessageTypeGuard = (
  state: AgentState
): NodeName | typeof END => {
  if (state.earlyExit === 'unsupported_message_type') return NODE.SEND;
  if (state.earlyExit) return END;
  return NODE.ESCALATION_GATE;
};

/**
 * Tras `escalationGate` (V-02, ADR-0002): interrupt determinista, corre en
 * todo turno sin excepción de sesión. Si detectó un pedido de humano, va
 * directo a SEND — no debe llegar a Ownership ni a ningún agente.
 */
export const routeAfterEscalationGate = (
  state: AgentState
): NodeName | typeof END => {
  if (state.earlyExit) return END;
  if (state.isHumanHandover) return NODE.SEND;
  return NODE.BUILD_DETECTION_CTX;
};

/**
 * Tras `buildDetectionContext`. Decide entre los cuatro grandes flujos según
 * el estado del onboarding/wizard de reservas/tipo de mensaje.
 */
export const routeAfterDetectionContext = (
  state: AgentState
): NodeName | typeof END => {
  if (state.earlyExit) return END;
  switch (state.contextRoute) {
    // @deprecated NODE.RESERVATION es el wizard legacy de reservas. Solo se
    // alcanza para sesiones con `reservation.step` ya en curso o si
    // `RESERVATION_AGENT_ENABLED` está apagado. Ver `reservation.service.ts`.
    case 'reservation_wizard':
      return NODE.RESERVATION;
    case 'reservation_agent':
      return NODE.RESERVATION_AGENT;
    case 'onboarding_agent':
      return NODE.ONBOARDING_AGENT;
    case 'onboarding_by_state':
      return NODE.ONBOARDING_BY_STATE;
    case 'address_capture':
      return NODE.ADDRESS_CAPTURE;
    case 'checkout':
      return NODE.CHECKOUT_AGENT;
    case 'interactive':
      return NODE.INTERACTIVE;
    case 'nlp':
      return NODE.NLP;
    default:
      return END;
  }
};

/**
 * Tras cualquier nodo que produce `handlerResult`: si hay resultado, pasa por
 * el gate de selección de tipo de entrega antes de validar la dirección.
 *
 * Excepciones que van directo a SEND:
 * - `isHumanHandover`: el bot derivó a un agente humano (SUPPORT).
 * - `dataCollectionDelegated`: el ReAct agent manejó el turno y recolecta
 *   datos (party-size, nombre, dirección) vía contexto + tools de escritura.
 *   Los post-gates quedan obsoletos para esta ruta.
 */
export const routeAfterHandlerOrSubflow = (
  state: AgentState
): NodeName | typeof END => {
  if (state.handlerResult) {
    if (state.isHumanHandover) return NODE.SEND;
    if (state.dataCollectionDelegated) return NODE.SEND;
    return NODE.FULFILLMENT_SELECTION;
  }
  return END;
};

/**
 * Tras `fulfillmentSelection`:
 * - Si `fulfillmentSelectionPending` es `true`, el gate reemplazó el
 *   handlerResult con la pregunta de selección → ir directo a SEND.
 * - Si sigue habiendo `handlerResult` (el gate pasó de largo) → ADDRESS_COLLECTION.
 * - Si no hay handlerResult → END.
 */
export const routeAfterFulfillmentSelection = (
  state: AgentState
): NodeName | typeof END => {
  if (state.fulfillmentSelectionPending) return NODE.SEND;
  if (state.handlerResult) return NODE.ADDRESS_COLLECTION;
  return END;
};

/**
 * Tras `addressCollection`: siempre pasa a `nameCollection` si hay resultado.
 */
export const routeAfterAddressCollection = (
  state: AgentState
): NodeName | typeof END => {
  if (state.handlerResult) return NODE.NAME_COLLECTION;
  return END;
};

/**
 * Tras `nameCollection`: si hay `handlerResult` (puede haber sido creado o
 * modificado por el nodo), envía; si no, termina.
 */
export const routeAfterNameCollection = (
  state: AgentState
): NodeName | typeof END => {
  if (state.handlerResult) return NODE.SEND;
  return END;
};

/**
 * @deprecated Router del wizard LEGACY de reservas. Ver `reservation.service.ts`.
 *
 * Tras `reservationWizard`:
 * - DELEGATE: el wizard pausó la reserva → encadenar INTERACTIVE/NLP en el mismo invoke.
 * - FULFILL_STEP: hay handlerResult → mismo comportamiento que routeAfterHandlerOrSubflow.
 */
export const routeAfterReservation = (
  state: AgentState
): NodeName | typeof END => {
  if (state.reservationDelegateRoute === 'interactive') return NODE.INTERACTIVE;
  if (state.reservationDelegateRoute === 'nlp') return NODE.NLP;
  if (state.handlerResult) {
    if (state.isHumanHandover) return NODE.SEND;
    return NODE.FULFILLMENT_SELECTION;
  }
  return END;
};

/** Tras `sendResponse`: persistir el mensaje AI salvo que se haya pedido saltarlo. */
export const routeAfterSend = (state: AgentState): NodeName | typeof END => {
  if (state.skipAIPersistence) return END;
  return NODE.PERSIST_AI;
};
