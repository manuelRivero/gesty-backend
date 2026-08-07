import { ConversationIntent } from '../../../types/conversationIntent';
import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { textResponse } from '../utils';
import { SUPPORT_MESSAGE, handOverToHuman } from '../../../services/humanHandover.service';

export class SupportHandler implements IntentHandler {
  readonly command = ConversationIntent.SUPPORT;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.SUPPORT;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    await handOverToHuman({
      conversationId: ctx.conversationId,
      businessId: ctx.business?.id,
      customer: ctx.customer,
      reason: 'support_handler',
    });

    return textResponse(SUPPORT_MESSAGE);
  }
}
