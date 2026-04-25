import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { interactiveResponse, noResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { handleReservationIntent } from '../../../services/reservations';

export class ReservationHandler implements IntentHandler {
  readonly command = ConversationIntent.RESERVATION;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const result = await handleReservationIntent(ctx);
    if (result === null) return noResponse();
    if (
      typeof result === "object" &&
      result !== null &&
      "content" in result &&
      typeof result.isInteractive === "boolean"
    ) {
      return result as HandlerResult;
    }
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result);
  }
}
