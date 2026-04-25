// webhooks/handlers/viewMenuReturnHandler.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { handleViewMenuReturnFromWebhook } from '../../../services/category.service';
import { listResponse, noResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';

export class ViewMenuReturnHandler implements IntentHandler {
  readonly command = ConversationIntent.VIEW_MENU_RETURN;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.VIEW_MENU_RETURN;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const result = await handleViewMenuReturnFromWebhook(ctx.payload);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return listResponse(result);
  }
}