/**
 * Exposición de los Goals derivados del checkout (Fase 1 del roadmap de
 * migración, ver docs/arquitectura/ROADMAP-MIGRACION.md).
 *
 * `nextCheckoutStep` (ADR-0006) ya es el derivador puro del orden del
 * checkout — esta fase no construye nada nuevo, solo lo nombra como Goal y
 * lo usa como única fuente de verdad de "qué pregunta estructurada está
 * pendiente", reemplazando el flag persistido `checkout_pending_action` /
 * `checkout_pending_question` (V-06, V-08). Al no haber una segunda copia
 * del paso, no hay nada que reconciliar — el reconciliador desaparece
 * porque la duplicación que lo motivaba deja de existir (ADR-0012).
 */

import {
  FULFILLMENT_TYPE_SHORT_QUESTION,
  PAYMENT_METHOD_SHORT_QUESTION,
  CONFIRM_ORDER_SHORT_QUESTION,
} from '../productQuery/botMessages';
import type { CheckoutPendingAction } from './pendingActionRegistry';
import type { CheckoutStep } from './nextCheckoutStep';

export interface CheckoutPendingResolution {
  action: CheckoutPendingAction | null;
  question: string | null;
}

/**
 * Deriva el pending action estructurado (para `extractPendingTurnResponse`)
 * y la pregunta corta a re-mostrar, directamente del paso actual del
 * checkout. `fulfillment`, `payment` y `confirm` tienen una pregunta
 * enlatada de opción cerrada; `address`/`name` se piden en lenguaje natural
 * sin botones.
 */
export const resolveCheckoutPendingFromStep = (
  step: CheckoutStep
): CheckoutPendingResolution => {
  if (step === 'fulfillment') {
    return { action: 'fulfillment_type', question: FULFILLMENT_TYPE_SHORT_QUESTION };
  }
  if (step === 'payment') {
    return { action: 'payment_method', question: PAYMENT_METHOD_SHORT_QUESTION };
  }
  if (step === 'confirm') {
    return { action: 'confirm_order', question: CONFIRM_ORDER_SHORT_QUESTION };
  }
  return { action: null, question: null };
};

export type CheckoutGoalType =
  | 'DEFINIR_ENTREGA'
  | 'OBTENER_DIRECCION'
  | 'OBTENER_NOMBRE'
  | 'DEFINIR_METODO_DE_PAGO'
  | 'CONFIRMAR_PEDIDO'
  | null;

/** Nombra el paso derivado como uno de los Goals del catálogo cerrado (TAXONOMIA.md §2). */
export const checkoutGoalForStep = (step: CheckoutStep): CheckoutGoalType => {
  switch (step) {
    case 'fulfillment':
      return 'DEFINIR_ENTREGA';
    case 'address':
      return 'OBTENER_DIRECCION';
    case 'name':
      return 'OBTENER_NOMBRE';
    case 'payment':
      return 'DEFINIR_METODO_DE_PAGO';
    case 'confirm':
      return 'CONFIRMAR_PEDIDO';
    case 'done':
      return null;
  }
};

/**
 * Traza obligatoria (ADR-0007: "surfaced_intent es obligatorio y no
 * negociable") de qué Goal de checkout está activo este turno y por qué el
 * sistema lo eligió: `nextCheckoutStep` es la única razón — no hay ranking,
 * es un Constraint de orden (ADR-0006), no una prioridad de Intents.
 */
export const logCheckoutGoal = (params: {
  conversationId: string;
  step: CheckoutStep;
}): void => {
  console.log(
    JSON.stringify({
      event: '[goal] checkout_step',
      conversationId: params.conversationId,
      step: params.step,
      goal: checkoutGoalForStep(params.step),
    })
  );
};
