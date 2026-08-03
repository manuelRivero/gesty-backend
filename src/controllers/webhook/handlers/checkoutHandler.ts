import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { ConversationIntent } from '../../../types/conversationIntent';
import { noResponse, interactiveResponse, textResponse } from '../utils';
import { prisma } from '../../../lib/prisma';
import { getMpBannerDataUrl } from '../../../assets/mpBanner';
import {
  EMPTY_CART_BOT_MESSAGE,
  PAYMENT_METHOD_PROMPT_BOT_MESSAGE,
} from '../../../services/productQuery/botMessages';
import { formatBotUserMessage } from '../../../services/productQuery/utils';
import { getBusinessConfig } from '../../../services/businessConfig.service';
import { listOfferedPaymentMethods } from '../../../services/paymentMethods.service';
import { buildPaymentButtonsMessage } from '../../../services/payment/paymentButtons';

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

    const businessConfig = await getBusinessConfig(business.id);
    const paymentButtons = await buildOfferedPaymentChoice(
      business.id,
      businessConfig.external_delivery_enabled
    );

    // Si ya eligió método de pago, no preguntar de nuevo
    if (draft.payment_method === 'cash' || draft.payment_method === 'transfer') {
      return textResponse(
        formatBotUserMessage(
          '¿Cómo querés pagar?',
          '💳',
          'Ya tenés un método de pago seleccionado. Si querés cambiarlo usá los botones de abajo.'
        ),
        [{
          type: 'interactive',
          message: paymentButtons,
        }]
      );
    }

    if (draft.payment_method === 'online') {
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

    return interactiveResponse(paymentButtons);
  }
}

async function buildOfferedPaymentChoice(
  businessId: string,
  externalDeliveryEnabled: boolean
) {
  const methods = await listOfferedPaymentMethods(businessId, { externalDeliveryEnabled });
  return buildPaymentButtonsMessage(PAYMENT_METHOD_PROMPT_BOT_MESSAGE, methods);
}
