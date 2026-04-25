// webhooks/handlers/addItemHandler.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { interactiveResponse, noResponse, parseProductId, textResponse } from '../utils';
import { executeRemoveDraftOrderItemFromWebhook } from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class ConfirmRemoveActionHandler implements IntentHandler {
  readonly command = ConversationIntent.CONFIRM_REMOVE;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.CONFIRM_REMOVE;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const menuItemId = parseProductId(ctx.payloadId!);
    const result = await executeRemoveDraftOrderItemFromWebhook(ctx.payload, menuItemId);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result);
  }
}