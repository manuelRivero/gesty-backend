import type { EnrichedContext, HandlerResult, IntentClassification, IntentHandler } from '../types';
import { noResponse, textResponse } from '../utils';
import { handleAddItemFromWebhook } from '../../../services/cart.service';
import { MenuService } from '../../../services/menu.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class ModifyQuantityHandler implements IntentHandler {
  readonly command = ConversationIntent.MODIFY_QUANTITY;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.MODIFY_QUANTITY;
  }

  async execute(ctx: EnrichedContext, classification?: IntentClassification): Promise<HandlerResult | null> {
    const quantity = classification?.quantity ?? 1;

    // Prioridad 1: producto referenciado en la conversación (contexto inmediato)
    let productId: string | null =
      (ctx.conversation as { lastReferencedProductId?: string | null }).lastReferencedProductId ?? null;

    // Prioridad 2: buscar por nombre detectado por NLP
    if (!productId && classification?.detectedProductName) {
      const results = await MenuService.searchMenuItemsByKeyword({
        businessId: ctx.business.id,
        keyword: classification.detectedProductName,
      });
      if (results.length > 0) {
        productId = results[0].id;
      }
    }

    if (!productId) return noResponse();

    const result = await handleAddItemFromWebhook(ctx.payload, productId, quantity);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return textResponse(result.main, [
      { type: 'list' as const, listMessage: result.mainFollowUpList },
    ]);
  }
}
