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
  BUILD_DETECTION_CTX: 'buildDetectionContext',
  RESERVATION: 'reservationWizard',
  ONBOARDING_BY_STATE: 'onboardingByState',
  ADDRESS_CAPTURE: 'addressCapture',
  INTERACTIVE: 'interactiveSubgraph',
  NLP: 'nlpSubgraph',
  ADDRESS_COLLECTION: 'addressCollection',
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
    case 'reservation_wizard':
      return NODE.RESERVATION;
    case 'onboarding_by_state':
      return NODE.ONBOARDING_BY_STATE;
    case 'address_capture':
      return NODE.ADDRESS_CAPTURE;
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
 * el nodo de captura de dirección (y luego nombre) antes de enviar; si no, termina.
 */
export const routeAfterHandlerOrSubflow = (
  state: AgentState
): NodeName | typeof END => {
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

/** Tras `sendResponse`: persistir el mensaje AI salvo que se haya pedido saltarlo. */
export const routeAfterSend = (state: AgentState): NodeName | typeof END => {
  if (state.skipAIPersistence) return END;
  return NODE.PERSIST_AI;
};
