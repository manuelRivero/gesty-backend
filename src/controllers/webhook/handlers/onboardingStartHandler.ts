import { HandlerResult, IntentHandler, EnrichedContext } from '../types';
import { interactiveResponse, noResponse, textResponse } from '../utils';
import { AddressService } from '../../../services/address.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class OnboardingStartHandler implements IntentHandler {
  readonly command = ConversationIntent.ONBOARDING_START;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.ONBOARDING_START;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const result = await new AddressService().process(ctx);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result);
  }
}
