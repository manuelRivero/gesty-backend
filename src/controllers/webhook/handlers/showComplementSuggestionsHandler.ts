import { ConversationIntent } from '../../../types/conversationIntent';
import { materializeComplementSuggestionsList } from '../../../services/complementSuggestions.service';
import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { noResponse, normalizeToHandlerResult } from '../utils';

export class ShowComplementSuggestionsHandler implements IntentHandler {
  readonly command = ConversationIntent.COMPLEMENT_SHOW_SUGGESTIONS;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.COMPLEMENT_SHOW_SUGGESTIONS;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const result = await materializeComplementSuggestionsList(ctx);
    if (result === null) return noResponse();
    return normalizeToHandlerResult(result);
  }
}
