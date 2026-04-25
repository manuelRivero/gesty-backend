import OpenAI from 'openai';
import { classifyIntent } from '../domain/intent/intentClassifier';
import { evaluateConfidence } from '../domain/intent/confidenceEvaluator';
import { ConversationIntent, IntentDetectionResult } from '../domain/intent/types';
import { parseIntentResult } from '../domain/intent/intentValidator';
import { DetectionContext } from './ai/detection.service';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export const detectIntent = async (
  lastUserMessage: string,
  context: DetectionContext
): Promise<ConversationIntent> => {
  const result = await detectIntentWithConfidence(lastUserMessage, context);

  if (result.type === 'UNCERTAIN') {
    return result.candidates[0].intent;
  }

  return result.intent;
};

export const detectIntentWithConfidence = async (
  lastUserMessage: string,
  context: DetectionContext
): Promise<IntentDetectionResult> => {
  console.log("Classifier context:", {
    mode: context.conversationMode,
    lastProduct: context.lastReferencedProductName
  });
  console.log("Last user message:", lastUserMessage);
  // Intent classifier must remain stateless. Do not pass conversation history.
  const rawContent = await classifyIntent(lastUserMessage, context);
  const parsedResult = parseIntentResult(rawContent);

  if (!parsedResult) {
    return {
      type: 'CONFIDENT',
      intent: ConversationIntent.UNKNOWN,
      confidence: 0,
      allIntents: [ConversationIntent.UNKNOWN],
      responseType: 'TEXT',
      content: '',
      detectedProductName: null
    };
  }

  return evaluateConfidence(parsedResult, lastUserMessage);
};
