// webhooks/handlers/endConversationHandler.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { handleEndConversationFromWebhook } from '../../../services/conversation.service';
import { ConversationIntent } from '../../../types/conversationIntent';
import { noResponse, textResponse } from '../utils';

export class EndConversationHandler implements IntentHandler {
  readonly command = ConversationIntent.END_CONVERSATION;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.END_CONVERSATION;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const result = await handleEndConversationFromWebhook(ctx.payload);
    if (result === null) return noResponse();
    return textResponse(result);
  }
}