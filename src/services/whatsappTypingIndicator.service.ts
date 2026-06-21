import axios, { AxiosError } from 'axios';
import { isDryRunWhatsAppSend } from '../config/env';

const WHATSAPP_GRAPH_API_VERSION = 'v23.0';
const WHATSAPP_GRAPH_BASE_URL = `https://graph.facebook.com/${WHATSAPP_GRAPH_API_VERSION}`;

/**
 * Envía el indicador de escritura de WhatsApp Cloud API y marca el mensaje como leído.
 * El indicador desaparece al enviar una respuesta o tras ~25 segundos.
 */
export async function sendTypingIndicatorRequest(
  phoneNumberId: string,
  messageId: string
): Promise<void> {
  if (isDryRunWhatsAppSend()) {
    console.log('[WhatsAppTyping] DRY_RUN — typing indicator omitido', {
      phoneNumberId,
      messageId,
    });
    return;
  }

  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    console.error('[WhatsAppTyping] WHATSAPP_ACCESS_TOKEN no definido');
    return;
  }

  if (!phoneNumberId?.trim() || !messageId?.trim()) {
    console.warn('[WhatsAppTyping] phoneNumberId o messageId faltante, omitiendo');
    return;
  }

  try {
    await axios.post(
      `${WHATSAPP_GRAPH_BASE_URL}/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: {
          type: 'text',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('[WhatsAppTyping] Indicador de escritura enviado', { messageId });
  } catch (error) {
    const axiosError = error as AxiosError;
    const status = axiosError.response?.status;
    const data = axiosError.response?.data;
    const messageDetail =
      typeof data === 'string' ? data : JSON.stringify(data ?? {});

    console.error('[WhatsAppTyping] Error al enviar indicador de escritura:', {
      messageId,
      phoneNumberId,
      status: status ?? 'sin_status',
      detail: messageDetail,
    });
  }
}

/**
 * Dispara el indicador de escritura sin bloquear el flujo del agente.
 * Si la llamada a Meta falla, el error se registra y el procesamiento continúa.
 */
export function sendTypingIndicator(
  phoneNumberId: string,
  messageId: string
): void {
  void sendTypingIndicatorRequest(phoneNumberId, messageId);
}
