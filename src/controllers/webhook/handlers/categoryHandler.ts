import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { listResponse, noResponse, parseProductId, textResponse } from '../utils';
import { handleCategorySelectionFromWebhook } from '../../../services/category.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class CategoryHandler implements IntentHandler {
  readonly command = ConversationIntent.CATEGORY;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.CATEGORY;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const categoryId = parseProductId(ctx.payloadId!);
    
    const result = await handleCategorySelectionFromWebhook(ctx.payload, categoryId, 1);
    
    if (result === null) {
      return noResponse();
    }

    if (typeof result === 'string') {
      return textResponse(result);
    }

    return listResponse(result);
  }
}