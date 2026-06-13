import { WebhookContext, HandlerResult, IntentHandler } from '../types';
import { ConversationIntent } from '../../../types/conversationIntent';
import { textResponse } from '../utils';
import { createOnlinePaymentLink } from '../../../services/payment/payment.service';
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
        return textResponse(
          '🤖\n\n*No podemos procesar el pago online en este momento* 😔\n\n¿Querés pagar en efectivo al recibir tu pedido?',
          [{
            type: 'interactive',
            message: {
              type: 'interactive',
              interactive: {
                type: 'button',
                body: { text: '🤖\n\nPodés pagar en efectivo al recibir.' },
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
        ? `*¡Tu link de pago está listo!* 💳\n\nHacé click para pagar de forma segura con Mercado Pago:\n\n${result.initPoint}\n\n_Una vez confirmado el pago, recibirás la confirmación de tu pedido._`
        : `*Tu link de pago activo* 💳\n\nUsá este link para completar tu pago:\n\n${result.initPoint}\n\n_Completá el pago para confirmar tu pedido._`;

      return textResponse('🤖', [
        { type: 'image', dataUrl: getMpBannerDataUrl() },
        { type: 'text', message: `🤖\n\n${linkText}` },
      ]);
    } catch (err) {
      console.error('[PayOnlineHandler] error:', err);
      return textResponse(
        '🤖\n\n*No podemos procesar el pago online en este momento* 😔\n\nPor favor intentá de nuevo más tarde o elegí pagar en efectivo.',
        [{
          type: 'interactive',
          message: {
            type: 'interactive',
            interactive: {
              type: 'button',
              body: { text: '🤖\n\n¿Querés pagar en efectivo?' },
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
