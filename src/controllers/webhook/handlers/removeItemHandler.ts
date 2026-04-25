// src/controllers/webhook/handlers/removeItemHandler.ts

import { IntentHandler, EnrichedContext, HandlerResult, IntentClassification } from '../types';
import { textResponse, interactiveResponse, noResponse, parseProductId } from '../utils';
import { handleConfirmRemoveItemFromWebhook } from '../../../services/cart.service';
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
    const productId = parseProductId(ctx.payloadId!);
    
    if (!productId) {
      console.log('[RemoveItemHandler] No product name detected');
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