// webhooks/extractor.ts
import { randomUUID } from 'node:crypto';
import { WhatsAppWebhookPayload, WebhookContext } from './types';
import { extractPayloadId } from './utils';

/**
 * Eventos de entrega/lectura (statuses) sin cuerpo de mensaje: válidos para WhatsApp, no se procesan aquí.
 */
export function isWhatsAppStatusOnlyEvent(
  payload: WhatsAppWebhookPayload
): boolean {
  const value = payload?.entry?.[0]?.changes?.[0]?.value;
  if (!value || typeof value !== 'object') return false;
  const statuses = (value as { statuses?: unknown }).statuses;
  return Array.isArray(statuses) && statuses.length > 0;
}

export const extractContext = (payload: WhatsAppWebhookPayload): WebhookContext | null => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const phoneNumberId = value?.metadata?.phone_number_id;
  const to = message?.from;

  if (!message) {
    if (isWhatsAppStatusOnlyEvent(payload)) {
      console.debug('[Extractor] WhatsApp status event — no message body, skipping');
    } else {
      console.debug('[Extractor] No message found, ignoring...');
    }
    return null;
  }

  console.debug('[Extractor] Extracted context:', {
    phoneNumberId,
    to,
    message,
    value,
  });

  // Extraer payloadId una sola vez aquí
  const payloadId = extractPayloadId(message);

  return {
    payload,
    phoneNumberId,
    to,
    message,
    value,
    turnId: randomUUID().slice(0, 8),
    payloadId  // Ya procesado, los handlers lo usan directo
  };
};



