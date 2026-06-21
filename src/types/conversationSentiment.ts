/**
 * Estado emocional/conductual de la interacción actual del cliente con el bot.
 * Se evalúa con LLM después de cada mensaje y se persiste en `conversation.ai_sentiment`.
 *
 * Valores negativos (FRUSTRATED, NEEDS_HUMAN, ABANDONED) deben pintarse en color
 * de alerta en el panel admin para permitir intervención manual.
 */
export enum ConversationSentiment {
  /** Usuario muestra frustración, confusión reiterada o molestia explícita. */
  FRUSTRATED = 'FRUSTRATED',
  /** Usuario completó exitosamente un pedido o una reserva. */
  CONVERTED = 'CONVERTED',
  /** Usuario explora el menú/opciones sin intención clara de compra. */
  BROWSING = 'BROWSING',
  /** Interacción fluida y positiva; el usuario está avanzando hacia un pedido. */
  ENGAGED = 'ENGAGED',
  /** Situación compleja o reclamo que excede la capacidad del bot. */
  NEEDS_HUMAN = 'NEEDS_HUMAN',
  /** Usuario comenzó a pedir pero dejó el proceso incompleto y sin señal de regreso. */
  ABANDONED = 'ABANDONED',
  /** Mensajes fuera de contexto, irrelevantes o potencialmente spam. */
  SPAM = 'SPAM',
}

export const NEGATIVE_SENTIMENTS: ConversationSentiment[] = [
  ConversationSentiment.FRUSTRATED,
  ConversationSentiment.NEEDS_HUMAN,
  ConversationSentiment.ABANDONED,
];

export const POSITIVE_SENTIMENTS: ConversationSentiment[] = [
  ConversationSentiment.CONVERTED,
  ConversationSentiment.ENGAGED,
];

export interface ConversationSentimentResult {
  sentiment: ConversationSentiment;
  summary: string;
}
