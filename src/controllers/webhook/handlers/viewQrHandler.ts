import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { ConversationIntent } from '../../../types/conversationIntent';
import { handleViewQrIntent } from '../../../services/reservations';

export class ViewQrHandler implements IntentHandler {
  readonly command = ConversationIntent.VIEW_QR;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    return handleViewQrIntent(ctx);
  }
}
