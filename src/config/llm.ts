/**
 * Singletons LangChain (`ChatOpenAI`, `OpenAIEmbeddings`) configurados con los
 * mismos modelos que usa hoy [services/ai/openai.service.ts] y
 * [services/ai/detection.service.ts] del backend original.
 *
 * Esta capa NO sustituye a `services/ai/*`: esos servicios siguen usando el
 * SDK oficial de `openai` directamente para preservar 1:1 los prompts y la
 * lógica de billing (`evaluateSubscriptionForBotAi`, `incrementUsage`,
 * `ai_blocked`).
 *
 * Las instancias de aquí están pensadas para:
 * - El nodo `intentDetectionNode` cuando se quiera evolucionar a
 *   `withStructuredOutput`/Zod (sin cambiar el prompt).
 * - El agente ReAct híbrido de la fase 2 (`AGENT_MODE=hybrid`).
 */

import { ChatOpenAI, OpenAIEmbeddings } from '@langchain/openai';
import { env } from './env';

let cachedDetector: ChatOpenAI | undefined;
let cachedReasoner: ChatOpenAI | undefined;
let cachedSmallModel: ChatOpenAI | undefined;
let cachedEmbeddings: OpenAIEmbeddings | undefined;

/** `gpt-4o-mini` `temperature: 0` `response_format: json_object` — clasificador de intención. */
export const getIntentDetectorLlm = (): ChatOpenAI => {
  if (!cachedDetector) {
    cachedDetector = new ChatOpenAI({
      model: 'gpt-4o-mini',
      temperature: 0,
      apiKey: env.OPENAI_API_KEY,
      modelKwargs: { response_format: { type: 'json_object' } },
    });
  }
  return cachedDetector;
};

/** `gpt-4o` `temperature: 0` — razonamiento más caro: `generateOrderResolution`, `generateOrderActionAnalysis`, `generateOrderExtraction`. */
export const getReasonerLlm = (): ChatOpenAI => {
  if (!cachedReasoner) {
    cachedReasoner = new ChatOpenAI({
      model: 'gpt-4o',
      temperature: 0,
      apiKey: env.OPENAI_API_KEY,
      modelKwargs: { response_format: { type: 'json_object' } },
    });
  }
  return cachedReasoner;
};

/** `gpt-4o-mini` `temperature: 0.2` — diálogo con producto, fallback, sugerencias. */
export const getSmallChatLlm = (): ChatOpenAI => {
  if (!cachedSmallModel) {
    cachedSmallModel = new ChatOpenAI({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      apiKey: env.OPENAI_API_KEY,
    });
  }
  return cachedSmallModel;
};

/** `text-embedding-3-small` — embeddings de productos y consultas (compatible con `getProductEmbedding`). */
export const getEmbeddings = (): OpenAIEmbeddings => {
  if (!cachedEmbeddings) {
    cachedEmbeddings = new OpenAIEmbeddings({
      model: 'text-embedding-3-small',
      apiKey: env.OPENAI_API_KEY,
    });
  }
  return cachedEmbeddings;
};
