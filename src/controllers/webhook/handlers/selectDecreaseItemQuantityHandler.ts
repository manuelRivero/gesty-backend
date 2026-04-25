// webhooks/handlers/addItemHandler.ts
import { IntentHandler } from '../types';
import { WebhookContext, HandlerResult } from '../types';
import { interactiveResponse, noResponse, parseProductId, textResponse } from '../utils';
import {  handleSelectQuantityDecreaseItemFromWebhook } from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class SelectDecreaseItemQuantityHandler implements IntentHandler {
  readonly command = ConversationIntent.DECREASE_ITEM_QUANTITY;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.DECREASE_ITEM_QUANTITY;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const itemID = parseProductId(ctx.payloadId!);
    const result = await handleSelectQuantityDecreaseItemFromWebhook(ctx.payload, itemID);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result);
  }
}