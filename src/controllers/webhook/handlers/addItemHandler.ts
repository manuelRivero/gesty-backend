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
import { isPartySizeMissingForOrderingTools } from '../../../services/partySizeGoal.service';
import { prisma } from '../../../lib/prisma';
import { hasVariations, variationByIndex } from '../../../services/menu/menuItemVariations';
import { clearPendingVariation } from '../../../services/pendingVariation.service';
import {
  buildPendingAddQuantityMessage,
  clearPendingAddQuantity,
  getPendingAddQuantity,
  maybeSetPendingAddQuantity,
} from '../../../services/pendingAddQuantity.service';
import {
  getPendingVariation,
  setPendingVariation,
} from '../../../services/pendingVariation.service';
import {
  isConfirmedAddQuantity,
  suggestAddQuantity,
} from '../../../services/addQuantitySuggestion';
import { assertCanOrder } from '../../../services/ordersCapabilityGate.service';
import {
  productResolutionErrorMessage,
  selectProductResolutionFromButton,
} from '../../../services/productResolution.service';

export class AddItemHandler implements IntentHandler {
  readonly command = ConversationIntent.ADD_ITEM;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.ADD_ITEM;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const ordersGate = await assertCanOrder(ctx.business.id);
    if (!ordersGate.ok) {
      return textResponse(ordersGate.message);
    }

    const payloadId = ctx.payloadId ?? '';
    const { productId: menuItemId, quantityFromPayload, variationIndex } =
      parseAddItemButtonPayload(payloadId);
    if (!menuItemId) return noResponse();

    const meta = normalizeMetadata(ctx.conversationState?.metadata);
    const partySize = getRequestedPartySize(meta);
    const pendingQty = getPendingAddQuantity(meta);
    const pendingVariation = getPendingVariation(meta);

    if (isPartySizeMissingForOrderingTools(meta)) {
      return textResponse(
        '🤖\n*¿Para cuántas personas?* 👥\n\nDecime cuántos comen y después sumamos el plato.'
      );
    }

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

    const pendingResolutionId =
      (pendingQty?.productId === menuItemId ? pendingQty.productResolutionId : null) ??
      (pendingVariation?.productId === menuItemId
        ? pendingVariation.productResolutionId
        : null);
    const buttonResolution = pendingResolutionId
      ? null
      : await selectProductResolutionFromButton({
          productId: menuItemId,
          businessId: ctx.business.id,
          conversationId: ctx.conversation.id,
        });
    if (buttonResolution && !buttonResolution.ok) {
      console.warn(JSON.stringify({
        event: '[product-resolution] button_rejected',
        reason: buttonResolution.reason,
        businessId: ctx.business.id,
        conversationId: ctx.conversation.id,
        productId: menuItemId,
      }));
      return textResponse(productResolutionErrorMessage(buttonResolution.reason));
    }
    const productResolutionId =
      pendingResolutionId ?? (buttonResolution?.ok ? buttonResolution.resolution.resolutionId : null);
    if (!productResolutionId) {
      return textResponse('No hay una selección vigente de ese producto. Volvé a elegirlo desde el menú.');
    }

    let resolvedVariation: string | null = null;
    if (hasVariations(item)) {
      if (variationIndex == null) {
        // qty en el picker es placeholder; el gate de cantidad corre después.
        await setPendingVariation({
          conversationId: ctx.conversation.id,
          productId: menuItemId,
          productResolutionId,
          productName: item.name,
          variations: item.variations,
          quantity: 1,
        });
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

    const pendingReply = Boolean(
      pendingQty &&
        pendingQty.productId === menuItemId &&
        quantityFromPayload != null
    );

    const qtyConfirmed = isConfirmedAddQuantity({
      quantity: quantityFromPayload,
      suggestedQuantity,
      pendingReply,
    });

    if (!qtyConfirmed) {
      const pending = await maybeSetPendingAddQuantity({
        conversationId: ctx.conversation.id,
        productId: menuItemId,
        productResolutionId,
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
      resolvedVariation,
      productResolutionId
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
