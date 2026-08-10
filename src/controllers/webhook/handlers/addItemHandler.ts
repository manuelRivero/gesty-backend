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
    const { productId: menuItemId, variationIndex } =
      parseAddItemButtonPayload(payloadId);
    if (!menuItemId) return noResponse();

    const meta = normalizeMetadata(ctx.conversationState?.metadata);
    const addQuantity = resolveAddItemQuantity({
      payloadId,
      metadata: meta,
    });

    // D5/D7 — el bot nunca agrega un platillo con variaciones sin haber
    // preguntado cuál quiere el cliente. Se resuelve acá, antes de tocar
    // el carrito, para que también cubra el flujo determinístico (la tool
    // del agente híbrido tiene su propio gate — ver Fase 5 del plan).
    const item = await prisma.menu_item.findFirst({
      where: { id: menuItemId, business_id: ctx.business.id },
      select: { id: true, name: true, variations: true },
    });
    if (!item) return noResponse();

    let resolvedVariation: string | null = null;
    if (hasVariations(item)) {
      if (variationIndex == null) {
        return listResponse(buildVariationPickerList(item, addQuantity));
      }
      const picked = variationByIndex(item.variations, variationIndex);
      if (!picked) {
        // El catálogo cambió entre que se mandó la lista y el cliente tocó.
        return listResponse(buildVariationPickerList(item, addQuantity));
      }
      resolvedVariation = picked;
    }

    const result = await handleAddItemFromWebhook(
      ctx.payload,
      menuItemId,
      addQuantity,
      'add',
      resolvedVariation
    );
    if (result === null) return noResponse();
    // Si había pendingVariation por un intento híbrido previo, el botón la cierra.
    await clearPendingVariation(ctx.conversation.id);
    if (typeof result === 'string') return textResponse(result);
    return textResponse(result.main, [
      { type: 'list' as const, listMessage: result.mainFollowUpList },
    ]);
  }
}
