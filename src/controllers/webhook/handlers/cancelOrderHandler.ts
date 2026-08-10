// webhooks/handlers/cancelOrderHandlerV2.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { handleCancelOrderFromWebhook } from '../../../services/order.service';
import { ConversationIntent } from '../../../types/conversationIntent';
import { noResponse, textResponse, interactiveResponse } from '../utils';

export class CancelOrderHandler implements IntentHandler {
  readonly command = ConversationIntent.CANCEL_ORDER;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.CANCEL_ORDER;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const result = await handleCancelOrderFromWebhook(ctx.payload, ctx.payloadId);
    if (result === null) return noResponse();
    if (typeof result === 'string') {
      return { ...textResponse(result), skipBodyHumanization: true };
    }
    return { ...interactiveResponse(result), skipBodyHumanization: true };
  }
}
