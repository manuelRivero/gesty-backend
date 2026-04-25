// webhooks/handlers/addItemHandler.ts
import { IntentHandler } from '../types';
import { WebhookContext, HandlerResult } from '../types';
import { interactiveResponse, noResponse, parseProductId, textResponse } from '../utils';
import { handleSelectQuantityIncreaseItemFromWebhook } from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class SelectIncreaseItemQuantityHandler implements IntentHandler {
  readonly command = ConversationIntent.INCREASE_ITEM_QUANTITY;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.INCREASE_ITEM_QUANTITY;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const itemID = parseProductId(ctx.payloadId!);
    const result = await handleSelectQuantityIncreaseItemFromWebhook(ctx.payload, itemID);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result);
  }
}