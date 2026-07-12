import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { noResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { formatBotUserMessage } from '../../../services/productQuery/utils';
import {
  createConversationMessage,
  findBusinessByPhoneNumberId,
  findOrCreateConversationState,
  findOrCreateCustomer,
  createOrGetOpenConversation,
  omitConversationMetadataKeys,
  updateConversationLastMessageAt,
} from '../../../repositories';

export class CancelRemoveActionHandler implements IntentHandler {
  readonly command = ConversationIntent.CANCEL_REMOVE;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.CANCEL_REMOVE;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const phoneNumberId = ctx.phoneNumberId;
    const from = ctx.to;
    if (!phoneNumberId || !from) return noResponse();

    const business = await findBusinessByPhoneNumberId(phoneNumberId);
    if (!business) return noResponse();

    const customer = await findOrCreateCustomer(business.id, from);
    const conversation = await createOrGetOpenConversation(
      business.id,
      customer.id
    );
    await findOrCreateConversationState(conversation.id);

    await omitConversationMetadataKeys(conversation.id, [
      'pendingAction',
      'pendingItemId',
      'pendingItemName',
      'pendingActionAt',
    ]);

    const text = formatBotUserMessage(
      'Listo',
      '✅',
      'No quité nada de tu pedido.\n\nPodés seguir editando o finalizar cuando quieras.'
    );
    await createConversationMessage(conversation.id, 'ai', text, false);
    await updateConversationLastMessageAt(conversation.id);

    return textResponse(text);
  }
}
