// webhooks/handlers/addItemHandler.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { interactiveResponse, noResponse, parseProductId, textResponse } from '../utils';
import { handleViewCartFromWebhook } from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class ViewCartHandler implements IntentHandler {
  readonly command = ConversationIntent.VIEW_CART;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.VIEW_CART;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const result = await handleViewCartFromWebhook(ctx.payload);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result);
  }
}