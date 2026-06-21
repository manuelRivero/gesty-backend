import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import {
  SENTIMENT_ANALYSIS_SYSTEM_PROMPT,
  buildSentimentAnalysisUserPrompt,
} from '../../prompts/conversationSentiment';
import {
  ConversationSentiment,
  type ConversationSentimentResult,
} from '../../types/conversationSentiment';

const SentimentResultSchema = z.object({
  sentiment: z.nativeEnum(ConversationSentiment),
  summary: z.string(),
});

let cachedSentimentLlm: ChatOpenAI | undefined;

const getSentimentLlm = (): ChatOpenAI => {
  if (!cachedSentimentLlm) {
    cachedSentimentLlm = new ChatOpenAI({
      model: 'gpt-4o-mini',
      temperature: 0,
      apiKey: env.OPENAI_API_KEY,
      modelKwargs: { response_format: { type: 'json_object' } },
    });
  }
  return cachedSentimentLlm;
};

/**
 * Analiza el sentimiento de la interacción actual (desde `started_at`) de una conversación.
 *
 * Devuelve `null` si no hay suficientes mensajes o si ocurre un error no crítico.
 * Diseñado para ejecutarse en background (fire-and-forget) sin bloquear el flujo principal.
 */
export const analyzeConversationSentiment = async (
  conversationId: string,
  sessionStartedAt: Date,
  minMessages = 1
): Promise<ConversationSentimentResult | null> => {
  const messages = await prisma.conversation_message.findMany({
    where: {
      conversation_id: conversationId,
      created_at: { gte: sessionStartedAt },
    },
    orderBy: { created_at: 'asc' },
    select: {
      sender: true,
      message: true,
      created_at: true,
    },
  });

  if (messages.length < minMessages) {
    return null;
  }

  const formattedMessages = messages.map((m) => ({
    sender: m.sender,
    message: m.message,
    createdAt: m.created_at,
  }));

  const llm = getSentimentLlm().withStructuredOutput(SentimentResultSchema);

  const result = await llm.invoke([
    new SystemMessage(SENTIMENT_ANALYSIS_SYSTEM_PROMPT),
    new HumanMessage(buildSentimentAnalysisUserPrompt(formattedMessages)),
  ]);

  return result;
};
