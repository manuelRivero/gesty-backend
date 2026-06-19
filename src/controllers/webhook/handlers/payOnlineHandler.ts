import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { ConversationIntent } from '../../../types/conversationIntent';
import { textResponse } from '../utils';
import { createOnlinePaymentLink } from '../../../services/payment/payment.service';
import {
  PAY_CASH_ASK_BOT_MESSAGE,
  PAY_CASH_OPTION_BOT_MESSAGE,
  PAY_ONLINE_RETRY_BOT_MESSAGE,
  PAY_ONLINE_UNAVAILABLE_BOT_MESSAGE,
} from '../../../services/productQuery/botMessages';
import { formatBotUserMessage } from '../../../services/productQuery/utils';
import { getMpBannerDataUrl } from '../../../assets/mpBanner';

export class PayOnlineHandler implements IntentHandler {
  readonly command = ConversationIntent.PAY_ONLINE;

  canHandle(intent: string): boolean {
    return intent === ConversationIntent.PAY_ONLINE;
  }

  async execute(ctx: WebhookContext): Promise<HandlerResult | null> {
    const business = (ctx as any).business;
    const customer = (ctx as any).customer;

    if (!business || !customer) return null;

    try {
      const result = await createOnlinePaymentLink(business.id, customer.phone_number);

      if (!result) {
        return textResponse(PAY_ONLINE_UNAVAILABLE_BOT_MESSAGE, [{
            type: 'interactive',
            message: {
              type: 'interactive',
              interactive: {
                type: 'button',
                body: { text: PAY_CASH_OPTION_BOT_MESSAGE },
                action: {
                  buttons: [
                    { type: 'reply', reply: { id: 'PAY_CASH', title: '💵 Efectivo' } },
                  ],
                },
              },
            } as any,
          }]
        );
      }

      const linkText = result.isNew
        ? formatBotUserMessage(
            'Link de pago listo',
            '💳',
            `Hacé click para pagar de forma segura con Mercado Pago:\n\n${result.initPoint}\n\n_Una vez confirmado el pago, recibirás la confirmación de tu pedido._`
          )
        : formatBotUserMessage(
            'Link de pago activo',
            '💳',
            `Usá este link para completar tu pago:\n\n${result.initPoint}\n\n_Completá el pago para confirmar tu pedido._`
          );

      return textResponse(linkText, [
        { type: 'image', dataUrl: getMpBannerDataUrl(), beforeContent: true },
      ]);
    } catch (err) {
      console.error('[PayOnlineHandler] error:', err);
      return textResponse(PAY_ONLINE_RETRY_BOT_MESSAGE, [{
          type: 'interactive',
          message: {
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text: PAY_CASH_ASK_BOT_MESSAGE },
              action: {
                buttons: [
                  { type: 'reply', reply: { id: 'PAY_CASH', title: '💵 Efectivo' } },
                ],
              },
            },
          } as any,
        }]
      );
    }
  }
}
