import { prisma } from '../../../lib/prisma';
import {
  buildPendingItemNoteMessage,
  setPendingItemNote,
} from '../../../services/pendingItemNote.service';
import { ConversationIntent } from '../../../types/conversationIntent';
import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { textResponse } from '../utils';

/**
 * Payload WA `ITEM_NOTE` (fila «Nota del pedido»).
 * No escribe el carrito: setea pendingItemNote + ask D5.
 */
export class ItemNoteHandler implements IntentHandler {
  readonly command = ConversationIntent.ITEM_NOTE;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.ITEM_NOTE;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const businessId =
      typeof ctx.business === 'object' && ctx.business
        ? (ctx.business as { id?: string }).id
        : undefined;
    const customerPhone =
      typeof ctx.customer === 'object' && ctx.customer
        ? (ctx.customer as { phone_number?: string }).phone_number ?? ctx.to
        : ctx.to;

    if (!businessId || !ctx.conversationId) {
      return textResponse(
        buildPendingItemNoteMessage(0)
      );
    }

    const draft = await prisma.draft_order.findFirst({
      where: {
        business_id: businessId,
        customer_phone: customerPhone,
        status: 'active',
      },
      include: {
        draft_order_item: {
          include: { menu_item: { select: { id: true, name: true } } },
        },
      },
    });

    const items = draft?.draft_order_item ?? [];
    if (items.length === 0) {
      return textResponse(
        '🤖\n\n*Sin ítems para anotar* 📝\n\nPrimero sumá algo al pedido y después pedí la nota.'
      );
    }

    let productId: string | null = null;
    let productName: string | null = null;
    if (items.length === 1) {
      productId = items[0].product_id;
      productName = items[0].menu_item?.name ?? null;
    }

    await setPendingItemNote({
      conversationId: ctx.conversationId,
      productId,
      productName,
      source: 'payload',
    });

    return textResponse(buildPendingItemNoteMessage(items.length, productName));
  }
}
