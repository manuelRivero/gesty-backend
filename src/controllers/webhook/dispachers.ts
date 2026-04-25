// src/controllers/webhook/dispatchers.ts

import { handlers } from './handlers';
import { detectIntentFromPayload } from './payloadMapper';
import {
  EnrichedContext,
  HandlerResult,
  IntentHandler,
  IntentClassification,
  WebhookContext
} from './types';


// src/webhooks/dispatchers/interactive.dispatcher.ts


export const dispatchInteractive = async (
  ctx: Omit<EnrichedContext, 'detection'>
): Promise<HandlerResult | null> => {

  if (!ctx.payloadId) {
    console.warn('[InteractiveDispatcher] No payloadId found');
    return null;
  }

  console.log('[InteractiveDispatcher] Handling payload:', ctx.payloadId);

  const classification = detectIntentFromPayload(ctx.payloadId);

  if (!classification) {
    console.warn('[InteractiveDispatcher] Unknown payload:', ctx.payloadId);
    return null;
  }

  const enrichedCtx: EnrichedContext = {
    ...ctx,
    detection: classification
  };

  return dispatchIntent(enrichedCtx);
};

const isIntentHandler = (handler: any): handler is IntentHandler => {
  return 'canHandle' in handler && typeof handler.canHandle === 'function';
};

// Dispatcher de intenciones
export const dispatchIntent = async (
  ctx: EnrichedContext
): Promise<HandlerResult | null> => {

  const { detection } = ctx;

  const handler = handlers.find(h =>
    isIntentHandler(h) && h.canHandle(detection.intent)
  );

  if (!handler) {
    console.log('[DispatchIntent] No handler for:', detection.intent);
    return null;
  }

  console.log('[DispatchIntent]', handler.command);

  const classification: IntentClassification = {
    intent: detection.intent,
    confidence: detection.confidence,
    detectedProductName: detection.detectedProductName,
    quantity: detection.quantity
  };

  return handler.execute(ctx, classification);
};