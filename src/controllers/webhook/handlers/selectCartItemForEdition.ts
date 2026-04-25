// webhooks/handlers/addItemHandler.ts
import { WebhookContext, HandlerResult, IntentHandler, EnrichedContext } from '../types';
import { listResponse, noResponse, parseProductId, textResponse } from '../utils';
import { handleCartItemSelectionFromWebhook } from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class SelectCartItemForEditionHandler implements IntentHandler {
  readonly command = ConversationIntent.SELECT_CART_ITEM;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.SELECT_CART_ITEM;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    console.log('[SelectCartItemForEditionHandler] Executing', ctx.payload, ctx.payloadId);
    const payloadId = parseProductId(ctx.payloadId!);
    if (!payloadId) return noResponse();
    const result = await handleCartItemSelectionFromWebhook(ctx.payload, payloadId);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return listResponse(result);
  }
}