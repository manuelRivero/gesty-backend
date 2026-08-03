/**
 * Capa de política determinística sobre la respuesta del agente de checkout.
 *
 * Distingue dos cosas que el modelo anterior conflacionaba en un solo
 * booleano:
 *
 * - **Actividad del agente** (`hasAgentActivitySignal`): el turno llamó a
 *   una tool reconocida (`present_fulfillment_options`,
 *   `present_payment_options`, `delegate_to_main`, `handback_to_main`,
 *   `save_payment_method`). Esto solo prueba que el agente hizo *algo*
 *   validado este turno — nunca prueba un hecho de negocio. Habilita
 *   `responseAllowed`: que el texto del turno se envíe tal cual en lugar
 *   de ser reemplazado por el fallback de continuación.
 * - **Evidencia de negocio** (`Boolean(orderId)`): la única prueba real de
 *   que una orden existe es el `orderId` devuelto por
 *   `createOrderFromDraft`. Ninguna tool de actividad (ni
 *   `present_payment_options` ni `delegate_to_main`) puede otorgar esto.
 *   Habilita `completionClaimAllowed` y `orderConfirmationAllowed`.
 *
 * `applyCheckoutResponsePolicy` no analiza el contenido del texto (no hay
 * regex ni keywords) — el texto del LLM se trata como la representación de
 * una acción ya validada. Hoy solo se usa `responseAllowed` para proteger
 * el fallback sin señal (el bug original: LLM cierra el pedido en texto
 * libre sin haber llamado ninguna tool). `completionClaimAllowed` y
 * `orderConfirmationAllowed` quedan expuestos para que futuras políticas
 * puedan restringir selectivamente afirmaciones de "datos completos" o de
 * "pedido confirmado" sin tener que rehacer esta distinción.
 */

import type { CheckoutAgentSignals } from '../../agents/checkoutAgent';
import {
  FULFILLMENT_TYPE_PROMPT_BOT_MESSAGE,
  PAYMENT_METHOD_PROMPT_BOT_MESSAGE,
} from '../productQuery/botMessages';
import { formatBotUserMessage } from '../productQuery/utils';

export interface CheckoutResponsePolicyResponse {
  text: string;
  signals: CheckoutAgentSignals;
}

export interface CheckoutResponsePolicyState {
  fulfillmentType: 'DELIVERY' | 'TAKE_AWAY' | null;
  paymentMethod: 'cash' | 'online' | 'transfer' | null;
  /** Evidencia real de que una orden fue creada este turno (viene de `createOrderFromDraft`). */
  orderId: string | null;
}

export type CheckoutResponsePolicyCorrection = 'closure_claim_without_evidence';

export interface CheckoutResponsePolicyResult {
  text: string;
  /** El texto del turno puede enviarse (hubo actividad de agente u orden real). No implica que pueda afirmar hechos de negocio. */
  responseAllowed: boolean;
  /** Puede afirmarse que los datos del checkout están completos. Hoy, solo con evidencia real de orden. */
  completionClaimAllowed: boolean;
  /** Puede afirmarse que el pedido fue confirmado/creado. Solo `Boolean(orderId)` — ninguna señal de actividad lo otorga. */
  orderConfirmationAllowed: boolean;
  corrections: CheckoutResponsePolicyCorrection[];
}

/** Prueba que el agente ejecutó una acción validada este turno. NO prueba ningún hecho de negocio. */
const hasAgentActivitySignal = (signals: CheckoutAgentSignals): boolean =>
  signals.presentFulfillmentOptions ||
  signals.presentPaymentOptions ||
  signals.delegateToMain ||
  signals.handback ||
  signals.paymentMethod !== null;

const CHECKOUT_IN_PROGRESS_BOT_MESSAGE = formatBotUserMessage(
  'Seguimos con tu pedido',
  '🛍️',
  'Todavía estamos terminando de armar tu pedido.'
);

/** Mensaje determinístico de continuación, elegido según qué falta en el draft real. */
const buildContinuationMessage = (state: CheckoutResponsePolicyState): string => {
  if (!state.fulfillmentType) return FULFILLMENT_TYPE_PROMPT_BOT_MESSAGE;
  if (!state.paymentMethod) return PAYMENT_METHOD_PROMPT_BOT_MESSAGE;
  return CHECKOUT_IN_PROGRESS_BOT_MESSAGE;
};

/**
 * Valida si la respuesta del agente de checkout puede enviarse tal cual.
 * Regla única sobre `responseAllowed`: sin actividad de agente y sin
 * evidencia de orden creada, el turno no puede afirmar la finalización
 * del pedido — se reemplaza el texto por un mensaje de continuación
 * determinístico basado en el estado real del draft, sin tocar señales,
 * tools ni el resto del flujo.
 *
 * `completionClaimAllowed`/`orderConfirmationAllowed` se calculan siempre
 * a partir de `orderId` únicamente, sin importar qué señal de actividad
 * haya disparado el turno.
 */
export const applyCheckoutResponsePolicy = (
  response: CheckoutResponsePolicyResponse,
  state: CheckoutResponsePolicyState
): CheckoutResponsePolicyResult => {
  const orderConfirmationAllowed = Boolean(state.orderId);
  const completionClaimAllowed = orderConfirmationAllowed;
  const responseAllowed = hasAgentActivitySignal(response.signals) || orderConfirmationAllowed;

  if (responseAllowed) {
    return {
      text: response.text,
      responseAllowed: true,
      completionClaimAllowed,
      orderConfirmationAllowed,
      corrections: [],
    };
  }

  return {
    text: buildContinuationMessage(state),
    responseAllowed: false,
    completionClaimAllowed,
    orderConfirmationAllowed,
    corrections: ['closure_claim_without_evidence'],
  };
};
