import type { WhatsAppInteractiveMessage } from '../../domain/intent/whatsappTemplates';
import type { OfferedPaymentMethod } from '../paymentMethods.service';
import { formatBotUserMessage } from '../productQuery/utils';

const WHATSAPP_BUTTON_TITLE_MAX = 20;

export type PaymentButtonAdjustment = {
  paymentMethod: string;
  label: string;
  adjustmentAmount: number;
  finalAmount: number;
  isSurcharge: boolean;
};

/**
 * Construye el mensaje interactivo de métodos de pago a partir de los ofrecidos.
 * ≤3 → reply buttons; >3 → lista (límite de WhatsApp).
 */
export function buildPaymentButtonsMessage(
  bodyText: string,
  methods: OfferedPaymentMethod[],
  adjustments: PaymentButtonAdjustment[] = []
): WhatsAppInteractiveMessage {
  const adjustmentMap = new Map(adjustments.map((a) => [a.paymentMethod, a]));

  const titles = methods.map((m) => {
    const adj = adjustmentMap.get(m.id);
    const raw = adj
      ? `${m.emoji} ${m.buttonTitle} $${adj.finalAmount.toFixed(2)}`
      : `${m.emoji} ${m.buttonTitle}`;
    return {
      id: m.buttonId,
      title: raw.slice(0, WHATSAPP_BUTTON_TITLE_MAX),
      description: m.label,
    };
  });

  if (titles.length === 0) {
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: {
          text: formatBotUserMessage(
            'Sin métodos de pago',
            '⚠️',
            'Este negocio no tiene métodos de pago disponibles ahora. Probá más tarde o pedí ayuda.'
          ),
        },
        action: { buttons: [] },
      },
    } as unknown as WhatsAppInteractiveMessage;
  }

  if (titles.length <= 3) {
    return {
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: titles.map((t) => ({
            type: 'reply' as const,
            reply: { id: t.id, title: t.title },
          })),
        },
      },
    } as unknown as WhatsAppInteractiveMessage;
  }

  return {
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: 'Ver métodos',
        sections: [
          {
            title: 'Métodos de pago',
            rows: titles.map((t) => ({
              id: t.id,
              title: t.title,
              description: t.description.slice(0, 72),
            })),
          },
        ],
      },
    },
  } as unknown as WhatsAppInteractiveMessage;
}

export function buildPaymentChoiceBody(
  baseTotal: number,
  adjustments: PaymentButtonAdjustment[]
): string {
  if (adjustments.length === 0) {
    return formatBotUserMessage(
      '¿Cómo querés pagar?',
      '💳',
      `Total del pedido: $${baseTotal.toFixed(2)}\n\nElegí el método de pago para confirmar.`
    );
  }

  const lines = adjustments.map((a) => {
    const sign = a.isSurcharge ? '+' : '-';
    return `• ${a.label}: ${sign}$${Math.abs(a.adjustmentAmount).toFixed(2)}`;
  });

  return formatBotUserMessage(
    '¿Cómo querés pagar?',
    '💳',
    `Total del pedido: $${baseTotal.toFixed(2)}\n\n${lines.join('\n')}\n\nElegí el método de pago para confirmar.`
  );
}
