import type { IntentDetectionResult } from './ai/detection.service';
import type { ConversationMetadata } from './productQuery/types';
import {
  formatBotUserMessage,
  getRequestedPartySize,
} from './productQuery/utils';
import { ConversationIntent } from '../types/conversationIntent';
import { extractStrictNumericPeopleCount } from '../helpers/peopleCountExtraction';

const PARTY_SIZE_REQUIRED_INTENTS = new Set<ConversationIntent>([
  ConversationIntent.PRODUCT_QUERY,
  ConversationIntent.PRODUCT_ATTRIBUTE_QUESTION,
  ConversationIntent.ORDER_FOOD,
  ConversationIntent.RECOMMENDATION_REQUEST,
]);

/**
 * True si el intent de pedido/búsqueda requiere número de personas y aún no está definido.
 *
 * Importante: NO usamos `detection.quantity` como party size. Ese campo suele ser
 * unidades del plato ("un lomito", "2 pizzas"), no comensales. Solo cuenta lo
 * persistido en metadata (`peopleCount` / `requestedPartySize`).
 */
export function shouldBlockForMissingPeopleCount(params: {
  intent: ConversationIntent;
  metadata: ConversationMetadata;
  /** @deprecated Ignorado — no confundir unidades del plato con comensales. */
  detectionQuantity?: number | null;
}): boolean {
  const { intent, metadata } = params;
  if (!PARTY_SIZE_REQUIRED_INTENTS.has(intent)) {
    return false;
  }
  const effective = getRequestedPartySize(metadata);
  return effective == null || effective <= 0;
}

/**
 * "2" solo, sin party size en sesión y sin producto nombrado: es respuesta de
 * personas, no cambio de cantidad del carrito.
 */
export function shouldTreatBareNumberAsPartySize(params: {
  userMessage: string;
  intent: ConversationIntent;
  metadata: ConversationMetadata;
  detectedProductName?: string | null;
}): boolean {
  if (extractStrictNumericPeopleCount(params.userMessage) == null) return false;
  if (getRequestedPartySize(params.metadata) != null) return false;
  if (params.detectedProductName?.trim()) return false;

  return (
    params.intent === ConversationIntent.MODIFY_QUANTITY ||
    params.intent === ConversationIntent.INCREASE_ITEM ||
    params.intent === ConversationIntent.DECREASE_ITEM ||
    params.intent === ConversationIntent.INCREASE_ITEM_QUANTITY ||
    params.intent === ConversationIntent.DECREASE_ITEM_QUANTITY ||
    params.intent === ConversationIntent.UNKNOWN
  );
}

/**
 * Hint de un solo turno tras confirmar party size y reanudar la consulta
 * congelada. Se inyecta vía EnrichedContext (no metadata persistida).
 */
export function buildPartySizeJustConfirmedContextLines(
  justConfirmed: number | undefined | null
): string[] {
  if (justConfirmed == null || !Number.isFinite(justConfirmed) || justConfirmed <= 0) {
    return [];
  }
  const n = Math.trunc(justConfirmed);
  return [
    `- Party size recién confirmado (${n}). Estás reanudando la consulta de comida.`,
    '  Si hay 1 producto claro → add_cart_item (sin quantity si el cliente no dijo unidades; la tool pedirá confirmación si hace falta).',
    '  Si hay ≥2 → present_product_cta(SELECT_FROM_LIST).',
    '  PROHIBIDO present_product_cta(ADD_ITEM) en este turno salvo que no puedas resolver el productId.',
    '  PROHIBIDO decir que ya sumaste sin add_cart_item exitoso. PROHIBIDO upsell vacío («¿algo más?»).',
  ];
}
