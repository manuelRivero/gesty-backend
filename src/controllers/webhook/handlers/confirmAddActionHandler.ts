// webhooks/handlers/addItemHandler.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { interactiveResponse, noResponse, parseProductId, textResponse } from '../utils';
import { handleConfirmAddItemFromWebhook } from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class ConfirmAddActionHandler implements IntentHandler {
  readonly command = ConversationIntent.CONFIRM_ADD;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.CONFIRM_ADD;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const menuItemId = parseProductId(ctx.payloadId!);
    const result = await handleConfirmAddItemFromWebhook(ctx.payload, menuItemId);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result);
  }
}