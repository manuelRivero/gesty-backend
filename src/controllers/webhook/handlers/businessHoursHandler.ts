import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { listResponse, noResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { buildBusinessHoursMessage } from '../../../services/businessHours.service';

export class BusinessHoursHandler implements IntentHandler {
  readonly command = ConversationIntent.BUSINESS_HOURS;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const result = await buildBusinessHoursMessage(ctx);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return listResponse(result);
  }
}
