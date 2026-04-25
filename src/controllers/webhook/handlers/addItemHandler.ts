// webhooks/handlers/addItemHandler.ts
import type { IntentHandler } from '../types';
import type { EnrichedContext, HandlerResult } from '../types';
import {
  noResponse,
  parseAddItemButtonPayload,
  textResponse,
} from '../utils';
import { handleAddItemFromWebhook } from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';
import {
  getRequestedPartySize,
  normalizeMetadata,
} from '../../../services/productQuery/utils';

function resolveAddItemQuantity(params: {
  payloadId: string;
  metadata: ReturnType<typeof normalizeMetadata>;
}): number {
  const { quantityFromPayload } = parseAddItemButtonPayload(params.payloadId);
  // ADD_ITEM:<id>:<n> en el payload siempre manda (p. ej. :1 en "Agregar 1"); no pisar con sugerencias.
  if (quantityFromPayload != null) {
    return Math.min(99, Math.max(1, Math.floor(quantityFromPayload)));
  }
  const last = params.metadata.lastListSuggestedQuantity;
  if (last != null && last >= 1) {
    return Math.min(99, Math.floor(last));
  }
  const people = getRequestedPartySize(params.metadata);
  if (people != null && people >= 1) {
    return Math.min(99, Math.floor(people));
  }
  return 1;
}

export class AddItemHandler implements IntentHandler {
  readonly command = ConversationIntent.ADD_ITEM;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.ADD_ITEM;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const payloadId = ctx.payloadId ?? '';
    const { productId: menuItemId } = parseAddItemButtonPayload(payloadId);
    if (!menuItemId) return noResponse();

    const meta = normalizeMetadata(ctx.conversationState?.metadata);
    const addQuantity = resolveAddItemQuantity({
      payloadId,
      metadata: meta,
    });

    const result = await handleAddItemFromWebhook(
      ctx.payload,
      menuItemId,
      addQuantity
    );
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return textResponse(result.main, [
      { type: 'list' as const, listMessage: result.mainFollowUpList },
    ]);
  }
}
