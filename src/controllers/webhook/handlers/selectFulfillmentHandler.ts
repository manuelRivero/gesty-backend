import { prisma } from '../../../lib/prisma';
import { omitConversationMetadataKeys } from '../../../repositories/conversationState.repository';
import { handleViewCartFromWebhook } from '../../../services/cart.service';
import { ConversationIntent } from '../../../types/conversationIntent';
import { interactiveResponse, noResponse, textResponse } from '../utils';
import type { EnrichedContext, HandlerResult, IntentHandler } from '../types';

class SelectFulfillmentHandler implements IntentHandler {
  readonly command: string;
  private readonly fulfillmentType: 'DELIVERY' | 'TAKE_AWAY';

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

    const draft = await prisma.draft_order.findFirst({
      where: { business_id: business.id, customer_phone: phone, status: 'active' },
      select: { id: true }
    });

    if (!draft) {
      return textResponse('No encontré un pedido activo. ¿Querés explorar el menú?');
    }

    await prisma.$executeRaw`
      UPDATE draft_order
      SET fulfillment_type = ${this.fulfillmentType}::"FulfillmentType"
      WHERE id = ${draft.id}::uuid
    `;

    // Limpiar la acción pendiente del metadata de conversación
    await omitConversationMetadataKeys(ctx.conversationId, ['pending_fulfillment_action']);

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
