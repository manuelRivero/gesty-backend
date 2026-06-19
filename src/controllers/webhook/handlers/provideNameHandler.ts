import { NAME_COLLECTION_PROMPT_MESSAGE } from '../../../services/nameCollectionGate.service';
import { buildProvideNameThanksMessage } from '../../../services/productQuery/botMessages';
import { ConversationIntent } from '../../../types/conversationIntent';
import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { textResponse } from '../utils';

export class ProvideNameHandler implements IntentHandler {
  readonly command = ConversationIntent.PROVIDE_NAME;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const name = ctx.detection.customerName?.trim();
    if (!name) return textResponse(NAME_COLLECTION_PROMPT_MESSAGE);
    return textResponse(buildProvideNameThanksMessage(name));
    // La persistencia en DB y la limpieza del flag la hace nameCollectionNode aguas abajo.
  }
}
