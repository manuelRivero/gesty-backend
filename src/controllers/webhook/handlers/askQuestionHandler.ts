// webhooks/handlers/askQuestionHandler.ts
import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { handleAskQuestionFromWebhook } from '../../../services/conversation.service';
import { noResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';

export class AskQuestionHandler implements IntentHandler {
  readonly command = ConversationIntent.ASK_QUESTION;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.ASK_QUESTION;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const result = await handleAskQuestionFromWebhook(ctx.payload);
    if (result === null) return noResponse();
    return textResponse(result);
  }
}