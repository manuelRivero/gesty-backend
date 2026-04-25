import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { ConversationIntent } from '../../../types/conversationIntent';
import { handleViewReservationIntent } from '../../../services/reservations';

export class ViewReservationHandler implements IntentHandler {
  readonly command = ConversationIntent.VIEW_RESERVATION;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    return handleViewReservationIntent(ctx);
  }
}
