import type { IntentDetectionResult } from './ai/detection.service';
import type { ConversationMetadata } from './productQuery/types';
import {
  formatBotUserMessage,
  resolveRequestedPartySize,
} from './productQuery/utils';
import { ConversationIntent } from '../types/conversationIntent';

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
 * True si el intent de pedido/búsqueda requiere número de personas y aún no está definido.
 */
export function shouldBlockForMissingPeopleCount(params: {
  intent: ConversationIntent;
  metadata: ConversationMetadata;
  detectionQuantity: number | null | undefined;
}): boolean {
  const { intent, metadata, detectionQuantity } = params;
  if (
    intent !== ConversationIntent.ORDER_FOOD &&
    intent !== ConversationIntent.PRODUCT_QUERY
  ) {
    return false;
  }
  if (metadata.awaitingPeopleCount) return false;

  const effective = resolveRequestedPartySize(detectionQuantity, metadata);
  return effective == null || effective <= 0;
}
