// webhooks/handlers/addItemHandler.ts
import type { IntentHandler } from '../types';
import type { EnrichedContext, HandlerResult } from '../types';
import {
  listResponse,
  noResponse,
  parseAddItemButtonPayload,
  textResponse,
} from '../utils';
import {
  buildVariationPickerList,
  handleAddItemFromWebhook,
} from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';
import {
  getRequestedPartySize,
  normalizeMetadata,
} from '../../../services/productQuery/utils';
import { prisma } from '../../../lib/prisma';
import { hasVariations, variationByIndex } from '../../../services/menu/menuItemVariations';
import { clearPendingVariation } from '../../../services/pendingVariation.service';
import {
  buildPendingAddQuantityMessage,
  clearPendingAddQuantity,
  maybeSetPendingAddQuantity,
} from '../../../services/pendingAddQuantity.service';
import {
  isConfirmedAddQuantity,
  suggestAddQuantity,
} from '../../../services/addQuantitySuggestion';

export class AddItemHandler implements IntentHandler {
  readonly command = ConversationIntent.ADD_ITEM;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.ADD_ITEM;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const payloadId = ctx.payloadId ?? '';
    const { productId: menuItemId, quantityFromPayload, variationIndex } =
      parseAddItemButtonPayload(payloadId);
    if (!menuItemId) return noResponse();

    const meta = normalizeMetadata(ctx.conversationState?.metadata);
    const partySize = getRequestedPartySize(meta);

    // D5/D7 — variación antes que cantidad (plan party-size D4).
    const item = await prisma.menu_item.findFirst({
      where: { id: menuItemId, business_id: ctx.business.id },
      select: {
        id: true,
        name: true,
        variations: true,
        serves_people: true,
      },
    });
    if (!item) return noResponse();

    let resolvedVariation: string | null = null;
    if (hasVariations(item)) {
      if (variationIndex == null) {
        // qty en el picker es placeholder; el gate de cantidad corre después.
        return listResponse(buildVariationPickerList(item, 1));
      }
      const picked = variationByIndex(item.variations, variationIndex);
      if (!picked) {
        return listResponse(buildVariationPickerList(item, 1));
      }
      resolvedVariation = picked;
    }

    const { suggestedQuantity } = suggestAddQuantity({
      partySize,
      servesPeople: item.serves_people,
    });

    const qtyConfirmed = isConfirmedAddQuantity({
      quantity: quantityFromPayload,
      suggestedQuantity,
    });

    if (!qtyConfirmed) {
      const pending = await maybeSetPendingAddQuantity({
        conversationId: ctx.conversation.id,
        productId: menuItemId,
        productName: item.name?.trim() || 'Este plato',
        servesPeople: item.serves_people,
        metadata: meta,
        variation: resolvedVariation,
        source: 'deterministic',
      });
      if (pending) {
        await clearPendingVariation(ctx.conversation.id);
        return textResponse(buildPendingAddQuantityMessage(pending));
      }
    }

    const addQuantity = qtyConfirmed
      ? Math.min(99, Math.max(1, Math.floor(quantityFromPayload!)))
      : 1;

    const result = await handleAddItemFromWebhook(
      ctx.payload,
      menuItemId,
      addQuantity,
      'add',
      resolvedVariation
    );
    if (result === null) return noResponse();
    await clearPendingVariation(ctx.conversation.id);
    await clearPendingAddQuantity(ctx.conversation.id);
    if (typeof result === 'string') return textResponse(result);
    if (result.complementOnly) {
      return listResponse(result.mainFollowUpList);
    }
    return textResponse(result.main, [
      { type: 'list' as const, listMessage: result.mainFollowUpList },
    ]);
  }
}
