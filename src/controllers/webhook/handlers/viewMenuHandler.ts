// webhooks/handlers/viewMenuHandler.ts
import {
  EnrichedContext,
  HandlerResult,
  IntentClassification,
  IntentHandler,
} from '../types';
import { handleViewMenuFromWebhook } from '../../../services/category.service';
import { clearComplementSuggestionSnapshot } from '../../../services/complementSuggestions.service';
import { listResponse, noResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { persistRequestedPartySizeIfPresent } from '../../../services/sessionPartySize.service';

export class ViewMenuHandler implements IntentHandler {
  readonly command = ConversationIntent.VIEW_MENU;
  
  canHandle(intent: string): boolean {
    return intent === ConversationIntent.VIEW_MENU;
  }

  async execute(
    ctx: EnrichedContext,
    classification?: IntentClassification
  ): Promise<HandlerResult | null> {
    await clearComplementSuggestionSnapshot(ctx.conversation.id);
    await persistRequestedPartySizeIfPresent(
      ctx.conversation.id,
      classification?.quantity
    );

    const result = await handleViewMenuFromWebhook(ctx.payload);
    console.log('DEBUG ViewMenuHandler result:', result);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return listResponse(result);
  }
}