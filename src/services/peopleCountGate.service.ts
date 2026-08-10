import type { IntentDetectionResult } from './ai/detection.service';
import type { ConversationMetadata } from './productQuery/types';
import {
  formatBotUserMessage,
  getRequestedPartySize,
} from './productQuery/utils';
import { ConversationIntent } from '../types/conversationIntent';
import { extractStrictNumericPeopleCount } from '../helpers/peopleCountExtraction';

/** Formato estándar del bot: 🤖, título en negrita, cuerpo con guía clara. */
export const PEOPLE_COUNT_PROMPT_MESSAGE = formatBotUserMessage(
  '¿Para cuántas personas?',
  '👥',
  'Así ajustamos recomendaciones y porciones.\n\n' +
    'Escribí *solo el número* con dígitos, sin letras ni texto extra (del *1* al *99*). Ejemplos: *3* o *12*.'
);

export const PEOPLE_COUNT_INVALID_REPLY_MESSAGE = formatBotUserMessage(
  'Escribí solo el número',
  '🔢',
  'Necesito *únicamente dígitos*: un número del *1* al *99*, en un solo mensaje.\n\n' +
    'Ej.: *5* — sin palabras, sin "personas" ni otros signos.'
);

export type PeopleCountResumePayload = {
  userMessage: string;
  detection: IntentDetectionResult;
};

export function parsePeopleCountResume(
  meta: ConversationMetadata
): PeopleCountResumePayload | null {
  const raw = meta.peopleCountResume;
  if (!raw || typeof raw !== 'object') return null;
  const userMessage =
    typeof (raw as { userMessage?: unknown }).userMessage === 'string'
      ? (raw as { userMessage: string }).userMessage.trim()
      : '';
  const detection = (raw as { detection?: unknown }).detection;
  if (!userMessage || !detection || typeof detection !== 'object') return null;
  const intent = (detection as { intent?: unknown }).intent;
  if (typeof intent !== 'string') return null;
  return { userMessage, detection: detection as IntentDetectionResult };
}

/**
 * Cuando el bot está esperando el número de personas y el usuario responde con
 * algo que NO es un número válido, este helper decide si debemos abandonar el
 * gate porque el usuario cambió de intención o preguntó por otra cosa.
 *
 * Criterio: si la nueva detección resuelve a una intención accionable (cualquier
 * cosa distinta de UNKNOWN), asumimos que el usuario dejó atrás la pregunta de
 * personas y procesamos el mensaje nuevo con normalidad. Si la detección es
 * UNKNOWN (ruido, texto sin sentido), mantenemos el gate y re-preguntamos.
 *
 * Excepción: un dígito solo ("2") nunca abandona — es la respuesta esperada,
 * aunque el clasificador lo confunda con MODIFY_QUANTITY.
 */
export function shouldAbandonPeopleCountForNewIntent(
  detection: IntentDetectionResult,
  userMessage?: string
): boolean {
  if (
    userMessage != null &&
    extractStrictNumericPeopleCount(userMessage) != null
  ) {
    return false;
  }
  return detection.intent !== ConversationIntent.UNKNOWN;
}

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
  if (metadata.awaitingPeopleCount) return false;
  if (metadata.awaitingPartySize) return false;

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
