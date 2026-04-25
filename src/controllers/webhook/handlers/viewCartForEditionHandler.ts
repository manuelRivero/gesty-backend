// webhooks/handlers/editCartHandler.ts
import { IntentHandler } from '../types';
import { WebhookContext, HandlerResult } from '../types';
import { interactiveResponse, noResponse, textResponse } from '../utils';
import { handleShowCartForEditionFromWebhook } from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class ViewCartForEditionHandler implements IntentHandler {
  readonly command = ConversationIntent.VIEW_CART_FOR_EDITION;
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.VIEW_CART_FOR_EDITION;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const result = await handleShowCartForEditionFromWebhook(ctx.payload);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result);
  }
}