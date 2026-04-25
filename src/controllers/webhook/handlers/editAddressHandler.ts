import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { noResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { AddressService } from '../../../services/address.service';

export class EditAddressHandler implements IntentHandler {
  readonly command = ConversationIntent.EDIT_ADDRESS;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const result = await new AddressService().startEdit(ctx);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return textResponse('🤖\n\n*Perfecto, decime la dirección nuevamente*, calle y número o mandame tu ubicación actual 📍');
  }
}
