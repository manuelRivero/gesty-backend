import { ConversationIntent } from '../../../types/conversationIntent';
import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { textResponse } from '../utils';
import { updateConversationState } from '../../../repositories/conversationState.repository';

const SUPPORT_MESSAGE =
  '🤖\n\n*Tu consulta fue derivada a nuestro equipo* 🎧\n\n' +
  'En breve, uno de nuestros asesores te atenderá con mucho gusto y resolverá todas tus dudas.\n\n' +
  'Espero poder acompañarte de nuevo en una próxima oportunidad. ¡Hasta pronto! 👋';

export class SupportHandler implements IntentHandler {
  readonly command = ConversationIntent.SUPPORT;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.SUPPORT;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    try {
      await updateConversationState(ctx.conversationId, {
        is_human_handled: true,
      });
      console.log('[SupportHandler] Conversation handed over to human:', {
        conversationId: ctx.conversationId,
      });
    } catch (error) {
      console.error('[SupportHandler] Failed to set is_human_handled:', error);
    }

    return textResponse(SUPPORT_MESSAGE);
  }
}
