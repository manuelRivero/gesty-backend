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
}): string {
  return formatBotUserMessage(
    'Pedido confirmado',
    '✅',
    `Número: #${params.orderId}\nTotal: $${params.total}\nPago: Efectivo al recibir`
  );
}

export function buildOrderDispatchThanksMessage(): string {
  return formatBotUserMessage(
    '¡Gracias!',
    '🙌',
    'Te avisaremos por este medio cuando tu pedido sea despachado.'
  );
}
