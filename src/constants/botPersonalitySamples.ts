/** Preguntas fijas para previsualizar el tono de cada personalidad en el admin. */
import {
  formatBotUserMessage,
  parseBotUserMessage,
} from '../services/productQuery/utils';

export const BOT_PERSONALITY_SAMPLE_QUESTIONS = [
  'Hola como están ?',
  'Quisiera hacer una reserva',
  'Quiero hacer un pedido',
] as const;

export type BotPersonalitySampleQuestion =
  (typeof BOT_PERSONALITY_SAMPLE_QUESTIONS)[number];

/** Título y emoji por defecto si el LLM no respeta el formato estándar. */
export const BOT_PERSONALITY_SAMPLE_DEFAULTS: Record<
  BotPersonalitySampleQuestion,
  { title: string; emoji: string }
> = {
  'Hola como están ?': { title: 'Saludo', emoji: '👋' },
  'Quisiera hacer una reserva': { title: 'Reservas', emoji: '📋' },
  'Quiero hacer un pedido': { title: 'Pedido', emoji: '🛒' },
};

/**
 * Formato estándar de mensaje del bot (WhatsApp):
 *
 * ```
 * 🤖
 *
 * *Título* emoji
 *
 * Cuerpo del mensaje…
 * ```
 *
 * En WhatsApp, `*texto*` se renderiza en negrita.
 */
export const BOT_WHATSAPP_MESSAGE_FORMAT_SPEC = `🤖\\n\\n*Título* emoji\\n\\nCuerpo`;

export type BotPersonalitySampleResponse = {
  question: string;
  response: string;
};

export function parseBotPersonalitySampleResponses(
  value: unknown
): BotPersonalitySampleResponse[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (
      typeof item !== 'object' ||
      item === null ||
      typeof (item as { question?: unknown }).question !== 'string' ||
      typeof (item as { response?: unknown }).response !== 'string'
    ) {
      return [];
    }

    const question = (item as { question: string }).question.trim();
    const response = (item as { response: string }).response.trim();
    if (!question || !response) {
      return [];
    }

    return [{ question, response }];
  });
}

export function ensureSampleResponseWhatsAppFormat(
  question: string,
  response: string
): string {
  const trimmed = response.trim();

  if (parseBotUserMessage(trimmed)) {
    return trimmed;
  }

  const defaults =
    BOT_PERSONALITY_SAMPLE_DEFAULTS[
      question as BotPersonalitySampleQuestion
    ] ?? { title: 'Respuesta', emoji: '💬' };

  let body = trimmed;
  if (body.startsWith('🤖')) {
    body = body.replace(/^🤖[\s\S]*?\n\n/, '').trim();
  }

  return formatBotUserMessage(defaults.title, defaults.emoji, body);
}
