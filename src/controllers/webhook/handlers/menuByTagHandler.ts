import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { listResponse, noResponse, parseMenuByTagPayload, textResponse } from '../utils';
import { handleMenuByTagSelectionFromWebhook } from '../../../services/category.service';
import { ConversationIntent } from '../../../types/conversationIntent';

export class MenuByTagHandler implements IntentHandler {
  readonly command = ConversationIntent.MENU_BY_TAG;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.MENU_BY_TAG;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const parsed = parseMenuByTagPayload(ctx.payloadId ?? '');
    if (!parsed) {
      return textResponse('Opción no válida.');
    }

    const result = await handleMenuByTagSelectionFromWebhook(
      ctx.payload,
      parsed.tag,
      parsed.page
    );

    if (result === null) {
      return noResponse();
    }

    if (typeof result === 'string') {
      return textResponse(result);
    }

    return listResponse(result);
  }
}
