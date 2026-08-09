import type { EnrichedContext, HandlerResult, IntentClassification, IntentHandler } from '../types';
import { noResponse, textResponse, normalizeToHandlerResult } from '../utils';
import {
  handleAddItemFromWebhook,
  executeRemoveDraftOrderItemFromWebhook,
} from '../../../services/cart.service';
import { MenuService } from '../../../services/menu.service';
import { prisma } from '../../../lib/prisma';
import { ConversationIntent } from '../../../types/conversationIntent';

export class ModifyQuantityHandler implements IntentHandler {
  readonly command = ConversationIntent.MODIFY_QUANTITY;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.MODIFY_QUANTITY;
  }

  async execute(ctx: EnrichedContext, classification?: IntentClassification): Promise<HandlerResult | null> {
    const quantity = classification?.quantity ?? 1;
    const quantityMode = classification?.quantityMode ?? 'absolute';

    // Prioridad 1: producto referenciado en la conversación (contexto inmediato)
    let productId: string | null =
      (ctx.conversation as { lastReferencedProductId?: string | null }).lastReferencedProductId ?? null;

    // Prioridad 2: buscar por nombre detectado por NLP
    if (!productId && classification?.detectedProductName) {
      const results = await MenuService.searchMenuItemsByKeyword({
        businessId: ctx.business.id,
        keyword: classification.detectedProductName,
      });
      if (results.length > 0) {
        productId = results[0].id;
      }
    }

    if (!productId) return noResponse();

    // "quita 1"/"sacá 2" (decrease): a diferencia de la cantidad ABSOLUTA
    // ("quiero solamente 1", "que queden 2"), acá `quantity` es cuánto restar
    // de lo que ya hay — no el total final. Hace falta leer la cantidad
    // actual para calcular el objetivo: si el resultado es 0 o negativo, se
    // remueve el ítem por completo (mismo flujo que REMOVE_ITEM) en vez de
    // dejar una fila con cantidad 0.
    if (quantityMode === 'decrease') {
      const draft = await prisma.draft_order.findFirst({
        where: {
          business_id: ctx.business.id,
          customer_phone: ctx.customer.phone_number,
          status: 'active',
        },
        include: { draft_order_item: { where: { product_id: productId } } },
      });
      const currentQty = draft?.draft_order_item[0]?.quantity ?? 0;
      if (currentQty <= 0) return noResponse();

      const target = currentQty - quantity;
      if (target <= 0) {
        const result = await executeRemoveDraftOrderItemFromWebhook(ctx.payload, productId);
        if (result === null) return noResponse();
        return normalizeToHandlerResult(result);
      }

      const result = await handleAddItemFromWebhook(ctx.payload, productId, target, 'set');
      if (result === null) return noResponse();
      if (typeof result === 'string') return textResponse(result);
      return {
        ...textResponse(result.main, [
          { type: 'list' as const, listMessage: result.mainFollowUpList },
        ]),
        skipBodyHumanization: true,
      };
    }

    // MODIFY_QUANTITY absoluto ("quiero solamente 1 de X", "que queden 2") —
    // a diferencia de ADD_ITEM/INCREASE_ITEM, que son aditivos. `mode: 'set'`
    // fija la cantidad final en vez de sumarla a lo que ya había (bug real:
    // antes usaba el mismo camino aditivo que ADD_ITEM).
    const result = await handleAddItemFromWebhook(ctx.payload, productId, quantity, 'set');
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return {
      ...textResponse(result.main, [
        { type: 'list' as const, listMessage: result.mainFollowUpList },
      ]),
      skipBodyHumanization: true,
    };
  }
}
