import type { AgentState, AgentStateUpdate } from '../../state';
import { ConversationIntent } from '../../../types/conversationIntent';

/**
 * @deprecated Conservado por compat de imports/tests. La captura de dirección
 * ya no corre en post-handlers interactive/nlp: solo onboarding y checkout.
 */
export const ADDRESS_SOFT_ASK_TTL_MS = 60 * 60 * 1000;

/**
 * @deprecated Ya no se usa para bloquear. La dirección no es requisito del
 * híbrido ni de intents de carrito/menú; se pide en onboarding o checkout.
 */
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
 * Post-handler de dirección: **no-op** en interactive/nlp.
 *
 * Pedir / capturar dirección es Ownership de onboarding o del agente de
 * checkout — no del híbrido ni de handlers de carrito/menú. Bloquear
 * VIEW_CART / ADD_ITEM / soft-ask acá robaba turnos (p. ej. "qué tengo en
 * mi pedido?" → "necesito tu dirección").
 *
 * El nodo se mantiene en el grafo para no romper el cableado; sale vacío.
 */
export const addressCollectionNode = async (
  _state: AgentState
): Promise<AgentStateUpdate> => {
  return {};
};
