import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { noResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { RETRY_ADDRESS_BOT_MESSAGE } from '../../../services/productQuery/botMessages';
import { AddressService } from '../../../services/address.service';
import { patchConversationMetadata } from '../../../repositories/conversationState.repository';

export class EditAddressHandler implements IntentHandler {
  readonly command = ConversationIntent.EDIT_ADDRESS;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    await patchConversationMetadata(ctx.conversationId, {
      onboarding_agent_active: true,
    });
    const result = await new AddressService().startEdit(ctx);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return textResponse(RETRY_ADDRESS_BOT_MESSAGE);
  }
}
