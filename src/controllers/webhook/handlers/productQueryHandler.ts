import {
  EnrichedContext,
  HandlerResult,
  IntentClassification,
  IntentHandler,
} from '../types';
import {
  interactiveResponse,
  listResponse,
  noResponse,
  textResponse,
} from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { executeProductQuery } from '../../../services/productQuery';
import type { WhatsAppInteractiveMessage } from '../../../domain/intent/whatsappTemplates';
import { persistRequestedPartySizeIfPresent } from '../../../services/sessionPartySize.service';

export class ProductQueryHandler implements IntentHandler {
  readonly command = ConversationIntent.PRODUCT_QUERY;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.PRODUCT_QUERY;
  }

  async execute(
    ctx: EnrichedContext,
    classification?: IntentClassification
  ): Promise<HandlerResult | null> {
    await persistRequestedPartySizeIfPresent(
      ctx.conversation.id,
      classification?.quantity
    );

    const result = await executeProductQuery(ctx, classification);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    if (result.type === 'list') return listResponse(result);
    return interactiveResponse(result as WhatsAppInteractiveMessage);
  }
}
