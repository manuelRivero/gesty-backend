import { describe, expect, it } from 'vitest';
import { validateCheckoutResponse } from '../checkoutValidation';
import type { CheckoutValidationState } from '../checkoutValidation';
import type { CheckoutAgentSignals } from '../../../agents/checkoutAgent';

const baseSignals = (): CheckoutAgentSignals => ({
  presentFulfillmentOptions: false,
  presentPaymentOptions: false,
  delegateToMain: false,
  delegateToMainReason: null,
  handback: false,
  handbackReason: null,
  paymentMethod: null,
});

/** Dirección y nombre resueltos por defecto: los tests de fulfillment/payment
 * no quieren que esos pasos interfieran salvo que se sobreescriban explícitamente. */
const baseState = (
  overrides: Partial<CheckoutValidationState> = {}
): CheckoutValidationState => ({
  fulfillmentType: null,
  paymentMethod: null,
  hasAddress: true,
  isInCoverage: true,
  customerName: 'Cliente Test',
  deliveryEnabled: true,
  takeawayEnabled: true,
  ...overrides,
});

describe('validateCheckoutResponse', () => {
  it('Caso 1: estado válido (fulfillment ya resuelto) + respuesta válida → acepta sin cambios', () => {
    const result = validateCheckoutResponse(
      baseState({ fulfillmentType: 'DELIVERY' }),
      { ...baseSignals(), presentPaymentOptions: true }
    );

    expect(result.valid).toBe(true);
    expect(result.corrections).toEqual([]);
    expect(result.signals.presentPaymentOptions).toBe(true);
  });

  it('Caso 2: intenta pasar a payment sin fulfillment resuelto → corrige a fulfillment', () => {
    const result = validateCheckoutResponse(
      baseState({ fulfillmentType: null }),
      { ...baseSignals(), presentPaymentOptions: true }
    );

    expect(result.valid).toBe(false);
    expect(result.corrections).toContain('payment_blocked_missing_prerequisite');
    expect(result.signals.presentPaymentOptions).toBe(false);
    expect(result.signals.presentFulfillmentOptions).toBe(true);
  });

  it('Caso 3: señales conflictivas (fulfillment y payment method simultáneos) → rechaza/corrige', () => {
    const result = validateCheckoutResponse(
      baseState({ fulfillmentType: 'TAKE_AWAY' }),
      { ...baseSignals(), presentFulfillmentOptions: true, paymentMethod: 'cash' }
    );

    expect(result.valid).toBe(false);
    expect(result.corrections).toContain('conflicting_fulfillment_and_payment_signals');
    expect(result.signals.paymentMethod).toBeNull();
    expect(result.signals.presentFulfillmentOptions).toBe(true);
  });

  it('Caso 4: campo obligatorio (fulfillment_type) faltante antes de payment vía save_payment_method → impide la transición', () => {
    const result = validateCheckoutResponse(
      baseState({ fulfillmentType: null, takeawayEnabled: false }),
      { ...baseSignals(), paymentMethod: 'online' }
    );

    expect(result.valid).toBe(false);
    expect(result.corrections).toContain('payment_blocked_missing_prerequisite');
    expect(result.signals.paymentMethod).toBeNull();
    expect(result.signals.presentFulfillmentOptions).toBe(true);
  });

  it('Caso 5: fulfillment DELIVERY sin dirección en cobertura → bloquea payment sin forzar fulfillment (no hay botón para dirección)', () => {
    const result = validateCheckoutResponse(
      baseState({ fulfillmentType: 'DELIVERY', hasAddress: false }),
      { ...baseSignals(), paymentMethod: 'cash' }
    );

    expect(result.valid).toBe(false);
    expect(result.corrections).toContain('payment_blocked_missing_prerequisite');
    expect(result.signals.paymentMethod).toBeNull();
    expect(result.signals.presentFulfillmentOptions).toBe(false);
  });

  it('Caso 6: fulfillment resuelto pero falta el nombre del cliente → bloquea payment', () => {
    const result = validateCheckoutResponse(
      baseState({ fulfillmentType: 'TAKE_AWAY', customerName: null }),
      { ...baseSignals(), presentPaymentOptions: true }
    );

    expect(result.valid).toBe(false);
    expect(result.corrections).toContain('payment_blocked_missing_prerequisite');
    expect(result.signals.presentPaymentOptions).toBe(false);
  });

  it('no interfiere con delegate_to_main aunque falte fulfillment', () => {
    const result = validateCheckoutResponse(
      baseState({ fulfillmentType: null }),
      { ...baseSignals(), delegateToMain: true, delegateToMainReason: 'pregunta por horarios' }
    );

    expect(result.valid).toBe(true);
    expect(result.signals.delegateToMain).toBe(true);
  });

  it('no interfiere con handback_to_main aunque falte fulfillment', () => {
    const result = validateCheckoutResponse(
      baseState({ fulfillmentType: null }),
      { ...baseSignals(), handback: true, handbackReason: 'cliente quiere cancelar' }
    );

    expect(result.valid).toBe(true);
    expect(result.signals.handback).toBe(true);
  });

  it('permite presentFulfillmentOptions solo, sin fulfillment resuelto', () => {
    const result = validateCheckoutResponse(
      baseState({ fulfillmentType: null }),
      { ...baseSignals(), presentFulfillmentOptions: true }
    );

    expect(result.valid).toBe(true);
    expect(result.corrections).toEqual([]);
    expect(result.signals.presentFulfillmentOptions).toBe(true);
  });
});
