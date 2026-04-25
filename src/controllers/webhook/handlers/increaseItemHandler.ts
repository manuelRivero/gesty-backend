// webhooks/handlers/addItemHandler.ts
import { IntentHandler } from '../types';
import { WebhookContext, HandlerResult } from '../types';
import { interactiveResponse, noResponse, parseProductId, parseQuantity, textResponse } from '../utils';
import { increaseItemQuantityFromWebhook } from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class IncreaseItemHandler implements IntentHandler {
  readonly command = ConversationIntent.INCREASE_ITEM;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.INCREASE_ITEM;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const splitPayloadId = parseProductId(ctx.payloadId!);
    if (!splitPayloadId) return noResponse();
    const quantity = parseQuantity(ctx.payloadId!);
    if (!quantity) return noResponse();
    // esto no và
    const result = await increaseItemQuantityFromWebhook(ctx.payload, splitPayloadId, Number(quantity));
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result);
  }
}