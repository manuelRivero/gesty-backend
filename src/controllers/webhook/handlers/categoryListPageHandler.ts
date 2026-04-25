// webhooks/handlers/categoryListPageHandler.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { listResponse, noResponse, parsePageOnly, textResponse } from '../utils';
import { handleCategoryListPageFromWebhook } from '../../../services/category.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class CategoryListPageHandler implements IntentHandler {
  readonly command = ConversationIntent.CATEGORY_LIST_PAGE;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.CATEGORY_LIST_PAGE;;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const page = parsePageOnly(ctx.payloadId!);
    const result = await handleCategoryListPageFromWebhook(ctx.payload, page);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return listResponse(result);
  }
}