import { applyFulfillmentSelectionIfPending } from '../../../tools/checkout';
import { handleViewCartFromWebhook } from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';
import { formatBotUserMessage } from '../../../services/productQuery/utils';
import { buildStaleOptionMessage } from '../../../services/activeInteraction.service';
import { interactiveResponse, noResponse, textResponse } from '../utils';
import type { EnrichedContext, HandlerResult, IntentHandler } from '../types';

class SelectFulfillmentHandler implements IntentHandler {
  readonly command: string;
  readonly fulfillmentType: 'DELIVERY' | 'TAKE_AWAY';

  constructor(intent: ConversationIntent, fulfillmentType: 'DELIVERY' | 'TAKE_AWAY') {
    this.command = intent;
    this.fulfillmentType = fulfillmentType;
  }

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const { business, customer } = ctx;
    const phone = customer?.phone_number ?? ctx.to;

    const { applied, error } = await applyFulfillmentSelectionIfPending(
      business.id,
      phone,
      ctx.conversationId,
      this.fulfillmentType
    );

    if (!applied) {
      if (error === 'no_active_cart') {
        return textResponse(
          formatBotUserMessage(
            'Sin pedido activo',
            '🛒',
            'No encontré un pedido activo. ¿Querés explorar el menú?'
          )
        );
      }
      // 'already_resolved' | 'no_pending' | 'wrong_draft': botón de una tanda
      // vieja — no corresponde a una solicitud vigente para el draft actual.
      return buildStaleOptionMessage();
    }

    // Mostrar el carrito con el tipo de entrega ya seteado
    const result = await handleViewCartFromWebhook(ctx.payload);
    if (result === null) return noResponse();
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result);
  }
}

export const SelectDeliveryHandler = new SelectFulfillmentHandler(
  ConversationIntent.SELECT_DELIVERY,
  'DELIVERY'
);

export const SelectTakeAwayHandler = new SelectFulfillmentHandler(
  ConversationIntent.SELECT_TAKE_AWAY,
  'TAKE_AWAY'
);
