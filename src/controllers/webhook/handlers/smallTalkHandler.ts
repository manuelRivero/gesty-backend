import { ConversationIntent } from '../../../types/conversationIntent';
import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { listResponse, noResponse, textResponse } from '../utils';
import { buildSmallTalkMenu } from '../../../services/smallTalk.service';

export class SmallTalkHandler implements IntentHandler {
  readonly command = ConversationIntent.SMALL_TALK;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const result = await buildSmallTalkMenu(ctx);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return listResponse(result);
  }
}