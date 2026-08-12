/**
 * Capa de política determinística sobre la respuesta del agente de checkout.
 *
 * Distingue dos cosas que el modelo anterior conflacionaba en un solo
 * booleano:
 *
 * - **Texto tipable del agente** (`responseAllowed`): el agente puede pedir
 *   nombre/dirección/fulfillment en prosa sin haber llamado `present_*`.
 *   D5-A (PLAN-ACCION-CHECKOUT-AUTONOMIA-POLICY): no se sustituye el copy
 *   por falta de señales de UI. Solo hay fallback residual si el texto
 *   llegó vacío, y siempre vía `nextCheckoutStep`.
 * - **Evidencia de negocio** (`Boolean(orderId)`): la única prueba real de
 *   que una orden existe es el `orderId` de `createOrderFromDraft`.
 *   Habilita `completionClaimAllowed` y `orderConfirmationAllowed` para
 *   políticas futuras de afirmación de orden — sin pisar prosa tipable.
 *
 * El borde duro de cierre está en los gates de write (`save_payment_method`,
 * `resolve_order_confirmation`, nodo) + `nextCheckoutStep`, no en esta policy.
 */

import type { CheckoutAgentSignals } from '../../agents/checkoutAgent';
import {
  ADDRESS_REQUIRED_BOT_MESSAGE,
  CUSTOMER_NAME_PROMPT_BOT_MESSAGE,
  FULFILLMENT_TYPE_PROMPT_BOT_MESSAGE,
  PAYMENT_METHOD_PROMPT_BOT_MESSAGE,
} from '../productQuery/botMessages';
import { formatBotUserMessage } from '../productQuery/utils';
import { nextCheckoutStep } from './nextCheckoutStep';

export interface CheckoutResponsePolicyResponse {
  text: string;
  signals: CheckoutAgentSignals;
}

export interface CheckoutResponsePolicyState {
  fulfillmentType: 'DELIVERY' | 'TAKE_AWAY' | null;
  paymentMethod: 'cash' | 'online' | 'transfer' | null;
  /** Evidencia real de que una orden fue creada este turno (viene de `createOrderFromDraft`). */
  orderId: string | null;
  hasAddress: boolean;
  isInCoverage: boolean;
  customerName: string | null;
  deliveryEnabled: boolean;
  takeawayEnabled: boolean;
}

export type CheckoutResponsePolicyCorrection = 'empty_agent_response';

export interface CheckoutResponsePolicyResult {
  text: string;
  /** El texto del turno puede enviarse. No implica que pueda afirmar hechos de negocio. */
  responseAllowed: boolean;
  /** Puede afirmarse que los datos del checkout están completos. Hoy, solo con evidencia real de orden. */
  completionClaimAllowed: boolean;
  /** Puede afirmarse que el pedido fue confirmado/creado. Solo `Boolean(orderId)`. */
  orderConfirmationAllowed: boolean;
  corrections: CheckoutResponsePolicyCorrection[];
}

const CHECKOUT_IN_PROGRESS_BOT_MESSAGE = formatBotUserMessage(
  'Seguimos con tu pedido',
  '🛍️',
  'Todavía estamos terminando de armar tu pedido.'
);

/**
 * Mensaje determinístico de continuación según `nextCheckoutStep` (única
 * fuente de verdad del paso — D2/D4). No inventa un orden paralelo.
 */
export const buildContinuationMessage = (state: CheckoutResponsePolicyState): string => {
  const step = nextCheckoutStep(
    {
      fulfillmentType: state.fulfillmentType,
      hasAddress: state.hasAddress,
      isInCoverage: state.isInCoverage,
      customerName: state.customerName,
      paymentMethod: state.paymentMethod,
    },
    {
      deliveryEnabled: state.deliveryEnabled,
      takeawayEnabled: state.takeawayEnabled,
    }
  );
  switch (step) {
    case 'fulfillment':
      return FULFILLMENT_TYPE_PROMPT_BOT_MESSAGE;
    case 'address':
      return ADDRESS_REQUIRED_BOT_MESSAGE;
    case 'name':
      return CUSTOMER_NAME_PROMPT_BOT_MESSAGE;
    case 'payment':
      return PAYMENT_METHOD_PROMPT_BOT_MESSAGE;
    case 'confirm':
    case 'done':
      return CHECKOUT_IN_PROGRESS_BOT_MESSAGE;
  }
};

/**
 * Valida si la respuesta del agente de checkout puede enviarse tal cual.
 *
 * D5-A: con texto no vacío, siempre se deja pasar (tipables en prosa son
 * válidos sin `present_*`). Fallback residual solo si el agente devolvió
 * vacío, alineado a `nextCheckoutStep`.
 *
 * `completionClaimAllowed`/`orderConfirmationAllowed` se calculan siempre
 * a partir de `orderId` únicamente.
 */
export const applyCheckoutResponsePolicy = (
  response: CheckoutResponsePolicyResponse,
  state: CheckoutResponsePolicyState
): CheckoutResponsePolicyResult => {
  const orderConfirmationAllowed = Boolean(state.orderId);
  const completionClaimAllowed = orderConfirmationAllowed;

  if (response.text.trim()) {
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
    corrections: ['empty_agent_response'],
  };
};
