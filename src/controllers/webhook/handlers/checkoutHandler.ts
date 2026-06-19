import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { ConversationIntent } from '../../../types/conversationIntent';
import { noResponse, interactiveResponse, textResponse } from '../utils';
import { prisma } from '../../../lib/prisma';
import type { WhatsAppInteractiveMessage } from '../../../domain/intent/whatsappTemplates';
import { getMpBannerDataUrl } from '../../../assets/mpBanner';
import {
  EMPTY_CART_BOT_MESSAGE,
  PAYMENT_METHOD_PROMPT_BOT_MESSAGE,
} from '../../../services/productQuery/botMessages';
import { formatBotUserMessage } from '../../../services/productQuery/utils';

export class CheckoutHandler implements IntentHandler {
  readonly command = ConversationIntent.CHECKOUT;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.CHECKOUT;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const business = (ctx as any).business;
    const customer = (ctx as any).customer;

    if (!business || !customer) return noResponse();

    const draft = await prisma.draft_order.findFirst({
      where: {
        business_id: business.id,
        customer_phone: customer.phone_number,
        status: 'active',
      },
    });

    if (!draft) {
      return textResponse(EMPTY_CART_BOT_MESSAGE);
    }

    // Si ya eligió método de pago, no preguntar de nuevo
    if (draft.payment_method === 'cash') {
      // Continúa el flujo cash via PAY_CASH handler (el draft ya tiene el método)
      return textResponse(
        formatBotUserMessage(
          '¿Cómo querés pagar?',
          '💳',
          'Ya tenés efectivo seleccionado. Si querés cambiarlo usá los botones de abajo.'
        ),
        [{
          type: 'interactive',
          message: buildPaymentChoiceMessage(),
        }]
      );
    }

    if (draft.payment_method === 'online') {
      // Reenviar el link de pago existente
      const existingIntent = await prisma.payment_intent.findFirst({
        where: { draft_order_id: draft.id, status: 'pending' },
        orderBy: { created_at: 'desc' },
      });
      if (existingIntent?.init_point) {
        return textResponse(
          formatBotUserMessage(
            'Link de pago online',
            '💳',
            `Ya generamos un link para tu pedido. Podés usarlo para completar el pago:\n\n${existingIntent.init_point}`
          ),
          [{ type: 'image', dataUrl: getMpBannerDataUrl(), beforeContent: true }]
        );
      }
    }

    // Sin payment_method: mostrar botones de elección
    return interactiveResponse(buildPaymentChoiceMessage());
  }
}

function buildPaymentChoiceMessage(): WhatsAppInteractiveMessage {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: PAYMENT_METHOD_PROMPT_BOT_MESSAGE,
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'PAY_ONLINE', title: '💳 Pago online' } },
          { type: 'reply', reply: { id: 'PAY_CASH', title: '💵 Efectivo' } },
        ],
      },
    },
  } as WhatsAppInteractiveMessage;
}
