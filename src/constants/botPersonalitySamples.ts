/** Preguntas fijas para previsualizar el tono de cada personalidad en el admin. */
export const BOT_PERSONALITY_SAMPLE_QUESTIONS = [
  'Hola como están ?',
  'Quisiera hacer una reserva',
  'Quiero hacer un pedido',
] as const;

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
