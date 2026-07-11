/**
 * Capa de validación determinística de reglas de negocio para el checkout.
 *
 * El agente LLM de checkout (`runCheckoutAgent`) decide libremente qué señal
 * emitir en cada turno (mostrar botones de fulfillment, mostrar botones de
 * pago, guardar un método de pago en texto libre, etc.). Esa decisión es
 * conversacionalmente razonable pero no tiene por qué respetar el orden
 * obligatorio del checkout: cart → fulfillment → payment → confirmation.
 *
 * `validateCheckoutResponse` es la única responsable de rechazar/corregir
 * transiciones inválidas antes de que el nodo (`resolveCheckoutAgentHandlerResult`)
 * actúe sobre ellas. No llama al LLM, no toca base de datos ni metadata de
 * conversación: solo transforma el objeto de señales en base al estado ya
 * conocido del draft.
 */

import type { CheckoutAgentSignals } from '../../agents/checkoutAgent';
import { nextCheckoutStep } from './nextCheckoutStep';

export interface CheckoutValidationState {
  fulfillmentType: 'DELIVERY' | 'TAKE_AWAY' | null;
  paymentMethod: 'cash' | 'online' | null;
  hasAddress: boolean;
  isInCoverage: boolean;
  customerName: string | null;
  deliveryEnabled: boolean;
  takeawayEnabled: boolean;
}

export type CheckoutValidationCorrection =
  | 'conflicting_fulfillment_and_payment_signals'
  | 'payment_blocked_missing_prerequisite';

export interface CheckoutValidationResult {
  /** Señales seguras para que el nodo actúe sobre ellas. */
  signals: CheckoutAgentSignals;
  /** `false` si `signals` difiere de la respuesta original del LLM. */
  valid: boolean;
  /** Motivos de las correcciones aplicadas, en orden. Vacío si `valid` es `true`. */
  corrections: CheckoutValidationCorrection[];
}

/**
 * Valida (y corrige si hace falta) la respuesta del agente de checkout contra
 * el estado real del draft, para que nunca se pueda saltar el paso de
 * fulfillment obligatorio antes de avanzar a payment.
 */
export const validateCheckoutResponse = (
  currentState: CheckoutValidationState,
  llmResponse: CheckoutAgentSignals
): CheckoutValidationResult => {
  const signals: CheckoutAgentSignals = { ...llmResponse };
  const corrections: CheckoutValidationCorrection[] = [];

  // Señales de control de flujo (no son transiciones de paso de checkout):
  // se dejan pasar sin validar.
  if (signals.delegateToMain || signals.handback) {
    return { signals, valid: true, corrections: [] };
  }

  const wantsPayment = signals.presentPaymentOptions || signals.paymentMethod !== null;
  const wantsFulfillment = signals.presentFulfillmentOptions;

  // Regla 4: campos/señales mutuamente excluyentes. No puede pedir mostrar
  // fulfillment y avanzar a payment en la misma respuesta: gana el paso
  // menos avanzado (fulfillment) y se descarta la señal de payment.
  if (wantsFulfillment && wantsPayment) {
    corrections.push('conflicting_fulfillment_and_payment_signals');
    signals.presentPaymentOptions = false;
    signals.paymentMethod = null;
  }

  // Regla 2/3: nunca permitir avanzar a payment (cart → fulfillment → dirección
  // → nombre → payment) saltando algún paso previo. `nextCheckoutStep` es la
  // única fuente de verdad de cuál es el paso real (Tarea 4.1/H-10) — se le
  // pasa `paymentMethod: null` a propósito para preguntar "¿qué falta ANTES
  // de payment?" sin que el propio paymentMethod once-resolved oculte pasos
  // previos incompletos.
  const stillWantsPayment = signals.presentPaymentOptions || signals.paymentMethod !== null;
  if (stillWantsPayment) {
    const step = nextCheckoutStep(
      {
        fulfillmentType: currentState.fulfillmentType,
        hasAddress: currentState.hasAddress,
        isInCoverage: currentState.isInCoverage,
        customerName: currentState.customerName,
        paymentMethod: null,
      },
      {
        deliveryEnabled: currentState.deliveryEnabled,
        takeawayEnabled: currentState.takeawayEnabled,
      }
    );
    if (step !== 'payment') {
      corrections.push('payment_blocked_missing_prerequisite');
      signals.presentPaymentOptions = false;
      signals.paymentMethod = null;
      // Solo fulfillment tiene una señal-UI propia para forzar; dirección y
      // nombre se piden en lenguaje natural (sin botones), el agente los
      // pide solo en el próximo turno según su propio prompt.
      if (step === 'fulfillment') {
        signals.presentFulfillmentOptions = true;
      }
    }
  }

  return {
    signals,
    valid: corrections.length === 0,
    corrections,
  };
};
