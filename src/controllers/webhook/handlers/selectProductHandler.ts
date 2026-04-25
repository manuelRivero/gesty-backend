// src/controllers/webhook/handlers/selectProductHandler.ts

import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { interactiveResponse, noResponse, textResponse } from '../utils';
import { handleProductSelectionFromWebhook } from '../../../services/whatsapp.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class SelectProductHandler implements IntentHandler {
  readonly command = ConversationIntent.SELECT_PRODUCT;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.SELECT_PRODUCT;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const result = await handleProductSelectionFromWebhook(
      ctx.payload,
      ctx.payloadId ?? ''
    );
    
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result)
  }
}