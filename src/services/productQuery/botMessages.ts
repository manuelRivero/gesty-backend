import { formatBotUserMessage } from './utils';

/** Mensajes compartidos con formato parseable por {@link parseBotUserMessage}. */

export const EMPTY_CART_BOT_MESSAGE = formatBotUserMessage(
  'Tu pedido está vacío',
  '🛒',
  'Podés explorar el menú para empezar tu pedido.'
);

export const NO_CART_ITEMS_TO_REMOVE_BOT_MESSAGE = formatBotUserMessage(
  'Sin items para remover',
  '🛒',
  'No tenés items en tu pedido para remover.\n\nPodés explorar el menú para empezar tu pedido.'
);

export const CLOSED_ORDER_CANCELLED_BOT_MESSAGE = formatBotUserMessage(
  'Pedido cancelado',
  '👋',
  'Entendido, cancelamos el pedido. ¡Hasta pronto!'
);

export const NO_PENDING_CLOSED_ORDER_BOT_MESSAGE = formatBotUserMessage(
  'Sin pedido pendiente',
  'ℹ️',
  'No hay pedido pendiente para confirmar.'
);

export const ADDRESS_OUT_OF_COVERAGE_BOT_MESSAGE = formatBotUserMessage(
  'Fuera de cobertura',
  '🚫',
  'Tu dirección de entrega quedó fuera de nuestra zona de cobertura.\n\nIngresá una nueva dirección o compartí tu ubicación para continuar con tu pedido.'
);

export const ADDRESS_REQUIRED_BOT_MESSAGE = formatBotUserMessage(
  'Dirección de entrega',
  '📍',
  'Para continuar con tu pedido necesito tu dirección de entrega.\n\nIndicame la calle y número o compartí tu ubicación.'
);

export const ADDRESS_SOFT_ASK_BOT_MESSAGE = formatBotUserMessage(
  'Dirección de entrega',
  '📍',
  'Por cierto, para poder procesar pedidos necesito tu dirección de entrega. ¿Me la podés indicar o compartir tu ubicación?'
);

export const RETRY_ADDRESS_BOT_MESSAGE = formatBotUserMessage(
  'Dirección de entrega',
  '📍',
  'Perfecto, decime la calle y número nuevamente o mandame tu ubicación actual.'
);

export const PAYMENT_METHOD_PROMPT_BOT_MESSAGE = formatBotUserMessage(
  '¿Cómo querés pagar?',
  '💳',
  'Elegí el método de pago para confirmar tu pedido.'
);

export const FULFILLMENT_TYPE_PROMPT_BOT_MESSAGE =
  '🤖\n\n*¿Cómo querés recibir tu pedido?* 🛍️\n\nElegí una opción para continuar:';

/**
 * Pregunta corta (sin emoji/formato de mensaje completo), para usar como
 * `checkout_pending_question` en metadata y en el resume tras una
 * interrupción (H-03). Guardar ahí la constante formateada de arriba
 * producía un texto pegado y duplicado: "Volviendo a tu pedido: 🤖\n\n*¿Cómo
 * querés recibir tu pedido?*..." (ver conversación de la Tarea 4.1).
 */
export const FULFILLMENT_TYPE_SHORT_QUESTION = '¿Delivery o retiro en el local?';

/** Ver `FULFILLMENT_TYPE_SHORT_QUESTION`. */
export const PAYMENT_METHOD_SHORT_QUESTION = '¿Efectivo o pago online?';

export const ADDRESS_SAVED_PAYMENT_PROMPT_BOT_MESSAGE = formatBotUserMessage(
  'Dirección guardada',
  '📍',
  '¿Cómo querés pagar?\n\nElegí el método de pago para confirmar tu pedido.'
);

export const PAY_ONLINE_UNAVAILABLE_BOT_MESSAGE = formatBotUserMessage(
  'Pago online no disponible',
  '😔',
  'No podemos procesar el pago online en este momento.\n\n¿Querés pagar en efectivo al recibir tu pedido?'
);

export const PAY_ONLINE_RETRY_BOT_MESSAGE = formatBotUserMessage(
  'Pago online no disponible',
  '😔',
  'No podemos procesar el pago online en este momento.\n\nPor favor intentá de nuevo más tarde o elegí pagar en efectivo.'
);

export const PAY_CASH_OPTION_BOT_MESSAGE = formatBotUserMessage(
  'Pago en efectivo',
  '💵',
  'Podés pagar en efectivo al recibir.'
);

export const PAY_CASH_ASK_BOT_MESSAGE = formatBotUserMessage(
  'Pago en efectivo',
  '💵',
  '¿Querés pagar en efectivo?'
);

export function buildCartItemNotFoundMessage(itemIdentifier: string): string {
  return formatBotUserMessage(
    'Producto no encontrado',
    '🔍',
    `No encontré "${itemIdentifier}" en tu pedido.\n\nPodés explorar el menú para empezar tu pedido.`
  );
}

export function buildCartProductNotFoundMessage(): string {
  return formatBotUserMessage(
    'Producto no encontrado',
    '🔍',
    'No encontré ese producto en tu pedido.'
  );
}

export function buildProvideNameThanksMessage(name: string): string {
  return formatBotUserMessage(
    '¡Gracias!',
    '😊',
    `Quedaste registrado como *${name}*.`
  );
}

export function buildOrderConfirmedCashMessage(params: {
  orderId: string;
  total: number;
  deliveryFee?: number;
  paymentAdjustment?: number;
}): string {
  const deliveryLine =
    params.deliveryFee && params.deliveryFee > 0
      ? `\nEnvío: $${params.deliveryFee.toFixed(2)}`
      : '';
  const adjustmentLine =
    params.paymentAdjustment !== undefined && params.paymentAdjustment !== 0
      ? `\n${params.paymentAdjustment > 0 ? 'Recargo' : 'Descuento'}: $${Math.abs(params.paymentAdjustment).toFixed(2)}`
      : '';
  return formatBotUserMessage(
    'Pedido confirmado',
    '✅',
    `Número: #${params.orderId}${deliveryLine}${adjustmentLine}\nTotal: $${params.total.toFixed(2)}\nPago: Efectivo al recibir`
  );
}

/**
 * Construye el mensaje interactivo de elección de método de pago.
 * Si hay configuraciones de ajuste, muestra el total final en cada botón.
 */
export function buildPaymentChoiceMessage(
  baseTotal: number,
  adjustments: Array<{
    paymentMethod: string;
    label: string;
    adjustmentAmount: number;
    finalAmount: number;
    isSurcharge: boolean;
  }>
): object {
  const adjustmentMap = new Map(adjustments.map((a) => [a.paymentMethod, a]));

  const onlineAdj = adjustmentMap.get('online');
  const cashAdj = adjustmentMap.get('cash');

  const onlineLabel = onlineAdj
    ? `💳 Online $${onlineAdj.finalAmount.toFixed(2)}`
    : '💳 Pago online';

  const cashLabel = cashAdj
    ? `💵 Efectivo $${cashAdj.finalAmount.toFixed(2)}`
    : '💵 Efectivo';

  let bodyText = formatBotUserMessage(
    '¿Cómo querés pagar?',
    '💳',
    `Total del pedido: $${baseTotal.toFixed(2)}\n\nElegí el método de pago para confirmar.`
  );

  if (adjustments.length > 0) {
    const lines = adjustments.map((a) => {
      const sign = a.isSurcharge ? '+' : '-';
      return `• ${a.label}: ${sign}$${Math.abs(a.adjustmentAmount).toFixed(2)}`;
    });
    bodyText = formatBotUserMessage(
      '¿Cómo querés pagar?',
      '💳',
      `Total del pedido: $${baseTotal.toFixed(2)}\n\n${lines.join('\n')}\n\nElegí el método de pago para confirmar.`
    );
  }

  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'PAY_ONLINE', title: onlineLabel.slice(0, 20) } },
          { type: 'reply', reply: { id: 'PAY_CASH', title: cashLabel.slice(0, 20) } },
        ],
      },
    },
  };
}

export function buildMinOrderNotMetMessage(params: {
  minOrderAmount: number;
  currentAmount: number;
  missing: number;
}): string {
  return formatBotUserMessage(
    'Monto mínimo de pedido',
    '⚠️',
    `El monto mínimo para delivery es *$${params.minOrderAmount.toFixed(2)}*.\n\nTu pedido actual suma $${params.currentAmount.toFixed(2)}. Te faltan $${params.missing.toFixed(2)} para continuar.\n\n¿Querés agregar algo más?`
  );
}

export function buildOrderDispatchThanksMessage(): string {
  return formatBotUserMessage(
    '¡Gracias!',
    '🙌',
    'Te avisaremos por este medio cuando tu pedido sea despachado.'
  );
}
