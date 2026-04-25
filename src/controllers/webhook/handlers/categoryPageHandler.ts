// webhooks/handlers/categoryPageHandler.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { listResponse, noResponse, parseCategoryPage, textResponse } from '../utils';
import { handleCategoryPageFromWebhook } from '../../../services/category.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class CategoryPageHandler implements IntentHandler {
  readonly command = ConversationIntent.CATEGORY_PAGE;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.CATEGORY_PAGE;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const { categoryId, page } = parseCategoryPage(ctx.payloadId!);
    
    // Función modificada: devuelve contenido, no envía
    const content = await handleCategoryPageFromWebhook(
      ctx.payload, 
      categoryId, 
      page
    );
    
    if (!content) {
      return noResponse();
    }

    if (typeof content === 'string') {
      return textResponse(content);
    }

    return listResponse(content);
  }
}