// webhooks/handlers/viewCategoriesHandlerV2.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { handleViewCategories } from '../../../services/category.service';
import { listResponse, noResponse, parsePageOnly, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';

export class ViewCategoriesHandler implements IntentHandler {
  readonly command = ConversationIntent.CATEGORY_LIST_PAGE;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.CATEGORY_LIST_PAGE;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const page = parsePageOnly(ctx.payloadId!);
    const result = await handleViewCategories(ctx.payload, page);
    
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return listResponse(result);
  }
}