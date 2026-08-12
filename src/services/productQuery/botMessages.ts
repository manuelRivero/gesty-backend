import { formatBotUserMessage } from './utils';
import {
  buildPaymentButtonsMessage,
  buildPaymentChoiceBody,
} from '../payment/paymentButtons';
import { shortOrderRef } from '../orderStatusNotification.service';

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

export const CUSTOMER_NAME_PROMPT_BOT_MESSAGE = formatBotUserMessage(
  'Nombre del pedido',
  '✏️',
  '¿Con qué nombre anotamos el pedido?'
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
export const FULFILLMENT_TYPE_SHORT_QUESTION =
  '¿Envío a domicilio o retiro en el local?';

/**
 * El LLM a veces lista "Delivery" / "Take Away" en el body. WhatsApp y el
 * cliente deben ver solo español (alineado a los botones del gate).
 */
export function localizeFulfillmentOptionLabels(text: string): string {
  return text
    .replace(/\*?Delivery\*?\s*\(\s*a domicilio\s*\)/gi, '*Envío a domicilio*')
    .replace(
      /\*?Take[\s-]?Away\*?\s*\(\s*retiro en el local\s*\)/gi,
      '*Retiro en el local*'
    )
    .replace(/\*Delivery\*/gi, '*Envío a domicilio*')
    .replace(/\*Take[\s-]?Away\*/gi, '*Retiro en el local*')
    .replace(/\bTake[\s-]?Away\b/gi, 'Retiro en el local')
    .replace(/\bDelivery\b/gi, 'Envío a domicilio');
}

/** Ver `FULFILLMENT_TYPE_SHORT_QUESTION`. */
export const PAYMENT_METHOD_SHORT_QUESTION = '¿Efectivo o pago online?';

/** Pregunta corta para el paso de confirmación final del pedido (antes de crear la orden). */
export const CONFIRM_ORDER_SHORT_QUESTION = '¿Confirmás tu pedido?';

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

/**
 * Confirmación de recepción de un comprobante de transferencia. D3: nunca
 * afirma que el pago quedó confirmado — un humano lo aprueba desde el panel.
 */
export const PAYMENT_PROOF_RECEIVED_BOT_MESSAGE = formatBotUserMessage(
  'Comprobante recibido',
  '🧾',
  'Recibimos tu comprobante, lo estamos verificando y te avisamos apenas quede confirmado.'
);

/**
 * Degradación suave (Tarea 4.1): si falla la descarga del adjunto o la subida
 * a storage, el cliente igual recibe una respuesta neutra — nunca queda sin
 * respuesta ni se crea un `payment_proof` huérfano.
 */
export const PAYMENT_PROOF_FALLBACK_BOT_MESSAGE = formatBotUserMessage(
  'Comprobante recibido',
  '🧾',
  'Recibimos tu mensaje. Estamos teniendo un problema para procesar la imagen; nuestro equipo lo revisa igual, no te preocupes.'
);

/**
 * Comprobante repetido (Fase 8): la misma imagen ya asociada a esta orden. No
 * se vuelve a procesar ni se llama a visión, pero se le contesta igual para
 * que el cliente sepa que está en curso.
 */
export const PAYMENT_PROOF_DUPLICATE_BOT_MESSAGE = formatBotUserMessage(
  'Ya lo tenemos',
  '🧾',
  'Este comprobante ya nos había llegado y lo estamos verificando. Te avisamos apenas quede confirmado.'
);

/**
 * Escalamiento a humano (Fase 8): la orden acumuló varios comprobantes cuyos
 * datos no coinciden con el pedido. El bot deja de procesar imágenes y una
 * persona del local sigue la conversación. No se le detalla al cliente qué
 * check falló: esa información le sirve a quien quiera calibrar un intento
 * siguiente, y a un cliente honesto lo confunde.
 */
export const PAYMENT_PROOF_ESCALATED_BOT_MESSAGE = formatBotUserMessage(
  'Lo revisamos con vos',
  '🎧',
  'Recibimos varios comprobantes y necesitamos verificarlos con más detalle. Una persona del local va a seguir esta conversación y te contacta a la brevedad.'
);

/**
 * Cierre del ciclo (Fase 9, D9): el bot le prometió al cliente "te avisamos
 * apenas quede confirmado" al recibir el comprobante — este es ese aviso.
 * Nunca se manda solo, siempre a través de `paymentProofNotification.service.ts`.
 */
export function buildPaymentProofApprovedMessage(orderId: string): string {
  const ref = shortOrderRef(orderId);
  return formatBotUserMessage(
    'Pago confirmado',
    '✅',
    `Pedido *#${ref}*\n\nConfirmamos tu pago. ¡Gracias! Ya estamos preparando tu pedido.`
  );
}

/**
 * Rechazo (Fase 9, D9): neutro a propósito. No menciona qué falló ni incluye
 * la `review_note` del admin — esa información le sirve a quien quiera
 * calibrar el intento siguiente, y a un cliente honesto lo confunde.
 */
export function buildPaymentProofRejectedMessage(orderId: string): string {
  const ref = shortOrderRef(orderId);
  return formatBotUserMessage(
    'Revisá tu comprobante',
    '🧾',
    `Pedido *#${ref}*\n\nNo pudimos confirmar el pago con el comprobante que enviaste. ¿Podés revisarlo y volver a mandarlo?`
  );
}

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

/**
 * Invitación a mandar el comprobante por el mismo chat cuando el método es
 * transferencia. Va en el builder (no en `instructions`, texto libre cargado
 * por cada dueño de negocio) para no depender de que cada local se acuerde
 * de mencionarlo — ver Tarea 4.2 del plan de comprobantes de transferencia.
 */
const TRANSFER_PROOF_INVITATION =
  'Cuando hagas la transferencia, mandame la foto o captura del comprobante por este mismo chat y la reviso.';

export function buildOrderConfirmedCashMessage(params: {
  orderId: string;
  total: number;
  deliveryFee?: number;
  paymentAdjustment?: number;
  /** Label del método (efectivo / transferencia / …). */
  paymentLabel?: string;
  /** Instrucciones extra (p. ej. CBU) para transferencia. */
  instructions?: string | null;
  /** `true` cuando el método es transferencia bancaria (`collectionKind === 'bank_transfer'`). */
  isBankTransfer?: boolean;
}): string {
  const deliveryLine =
    params.deliveryFee && params.deliveryFee > 0
      ? `\nEnvío: $${params.deliveryFee.toFixed(2)}`
      : '';
  const adjustmentLine =
    params.paymentAdjustment !== undefined && params.paymentAdjustment !== 0
      ? `\n${params.paymentAdjustment > 0 ? 'Recargo' : 'Descuento'}: $${Math.abs(params.paymentAdjustment).toFixed(2)}`
      : '';
  const paymentLabel = params.paymentLabel ?? 'Efectivo al recibir';
  const instructionsLine =
    params.instructions && params.instructions.trim()
      ? `\n\n${params.instructions.trim()}`
      : '';
  const transferProofInvitationLine = params.isBankTransfer
    ? `\n\n${TRANSFER_PROOF_INVITATION}`
    : '';
  return formatBotUserMessage(
    'Pedido confirmado',
    '✅',
    `Número: #${params.orderId}${deliveryLine}${adjustmentLine}\nTotal: $${params.total.toFixed(2)}\nPago: ${paymentLabel}${instructionsLine}${transferProofInvitationLine}`
  );
}

/**
 * @deprecated Preferí `buildPaymentButtonsMessage` + `listOfferedPaymentMethods`.
 * Se mantiene para tests legacy; sin lista de métodos ofrecidos asume cash+online.
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
  const bodyText = buildPaymentChoiceBody(baseTotal, adjustments);
  const fallbackMethods = [
    {
      id: 'online' as const,
      label: 'Pago online',
      buttonId: 'PAY_ONLINE',
      buttonTitle: 'Pago online',
      emoji: '💳',
      collectionKind: 'online_provider' as const,
      instructions: null,
      sortOrder: 1,
    },
    {
      id: 'cash' as const,
      label: 'Efectivo',
      buttonId: 'PAY_CASH',
      buttonTitle: 'Efectivo',
      emoji: '💵',
      collectionKind: 'at_delivery' as const,
      instructions: null,
      sortOrder: 0,
    },
  ];
  return buildPaymentButtonsMessage(bodyText, fallbackMethods, adjustments);
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
