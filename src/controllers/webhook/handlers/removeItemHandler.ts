// src/controllers/webhook/handlers/removeItemHandler.ts

import { IntentHandler, EnrichedContext, HandlerResult, IntentClassification } from '../types';
import { textResponse, interactiveResponse, noResponse, parseProductId } from '../utils';
import { handleConfirmRemoveItemFromWebhook } from '../../../services/cart.service';
import { MenuService } from '../../../services/menu.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class RemoveItemHandler implements IntentHandler {
  readonly command = ConversationIntent.REMOVE_ITEM;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.REMOVE_ITEM;
  }

  async execute(
    ctx: EnrichedContext, 
  ): Promise<HandlerResult | null> {
    console.log('[RemoveItemHandler] Executing', ctx.detection);

    let productId: string = '';

    if (ctx.payloadId) {
      // Flujo botón: payloadId = "REMOVE_ITEM:<uuid>" → extraer UUID directamente
      productId = parseProductId(ctx.payloadId);
    } else if (ctx.detection?.detectedProductName) {
      // Flujo NLP: resolver nombre (puede ser alias / display_name / nombre del admin)
      // contra el catálogo real usando búsqueda vectorial por embedding
      const results = await MenuService.searchMenuItemsByKeyword({
        businessId: ctx.business.id,
        keyword: ctx.detection.detectedProductName,
      });
      productId = results[0]?.id ?? '';
      console.log('[RemoveItemHandler] NLP keyword resolved to:', results[0]?.name ?? 'none');
    }
    
    if (!productId) {
      console.log('[RemoveItemHandler] No product id resolved');
      return textResponse('¿Qué producto querés remover de tu pedido? Decime el nombre.');
    }

    console.log('[RemoveItemHandler] Removing:', productId);

    const result = await handleConfirmRemoveItemFromWebhook(
      ctx.payload,
      productId
    );
    
    if (!result) {
      return noResponse();
    }
    if (typeof result === 'string') {
      return textResponse(result);
    }

    return interactiveResponse(result);
  }
}