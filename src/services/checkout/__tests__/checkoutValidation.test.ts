import { describe, expect, it } from 'vitest';
import { validateCheckoutResponse } from '../checkoutValidation';
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

describe('validateCheckoutResponse', () => {
  it('Caso 1: estado válido (fulfillment ya resuelto) + respuesta válida → acepta sin cambios', () => {
    const result = validateCheckoutResponse(
      {
        fulfillmentType: 'DELIVERY',
        paymentMethod: null,
        deliveryEnabled: true,
        takeawayEnabled: true,
      },
      { ...baseSignals(), presentPaymentOptions: true }
    );

    expect(result.valid).toBe(true);
    expect(result.corrections).toEqual([]);
    expect(result.signals.presentPaymentOptions).toBe(true);
  });

  it('Caso 2: intenta pasar a payment sin fulfillment resuelto → corrige a fulfillment', () => {
    const result = validateCheckoutResponse(
      {
        fulfillmentType: null,
        paymentMethod: null,
        deliveryEnabled: true,
        takeawayEnabled: true,
      },
      { ...baseSignals(), presentPaymentOptions: true }
    );

    expect(result.valid).toBe(false);
    expect(result.corrections).toContain('payment_blocked_missing_fulfillment');
    expect(result.signals.presentPaymentOptions).toBe(false);
    expect(result.signals.presentFulfillmentOptions).toBe(true);
  });

  it('Caso 3: señales conflictivas (fulfillment y payment method simultáneos) → rechaza/corrige', () => {
    const result = validateCheckoutResponse(
      {
        fulfillmentType: 'TAKE_AWAY',
        paymentMethod: null,
        deliveryEnabled: true,
        takeawayEnabled: true,
      },
      { ...baseSignals(), presentFulfillmentOptions: true, paymentMethod: 'cash' }
    );

    expect(result.valid).toBe(false);
    expect(result.corrections).toContain('conflicting_fulfillment_and_payment_signals');
    expect(result.signals.paymentMethod).toBeNull();
    expect(result.signals.presentFulfillmentOptions).toBe(true);
  });

  it('Caso 4: campo obligatorio (fulfillment_type) faltante antes de payment vía save_payment_method → impide la transición', () => {
    const result = validateCheckoutResponse(
      {
        fulfillmentType: null,
        paymentMethod: null,
        deliveryEnabled: true,
        takeawayEnabled: false,
      },
      { ...baseSignals(), paymentMethod: 'online' }
    );

    expect(result.valid).toBe(false);
    expect(result.corrections).toContain('payment_blocked_missing_fulfillment');
    expect(result.signals.paymentMethod).toBeNull();
    expect(result.signals.presentFulfillmentOptions).toBe(true);
  });

  it('no interfiere con delegate_to_main aunque falte fulfillment', () => {
    const result = validateCheckoutResponse(
      {
        fulfillmentType: null,
        paymentMethod: null,
        deliveryEnabled: true,
        takeawayEnabled: true,
      },
      { ...baseSignals(), delegateToMain: true, delegateToMainReason: 'pregunta por horarios' }
    );

    expect(result.valid).toBe(true);
    expect(result.signals.delegateToMain).toBe(true);
  });

  it('no interfiere con handback_to_main aunque falte fulfillment', () => {
    const result = validateCheckoutResponse(
      {
        fulfillmentType: null,
        paymentMethod: null,
        deliveryEnabled: true,
        takeawayEnabled: true,
      },
      { ...baseSignals(), handback: true, handbackReason: 'cliente quiere cancelar' }
    );

    expect(result.valid).toBe(true);
    expect(result.signals.handback).toBe(true);
  });

  it('permite presentFulfillmentOptions solo, sin fulfillment resuelto', () => {
    const result = validateCheckoutResponse(
      {
        fulfillmentType: null,
        paymentMethod: null,
        deliveryEnabled: true,
        takeawayEnabled: true,
      },
      { ...baseSignals(), presentFulfillmentOptions: true }
    );

    expect(result.valid).toBe(true);
    expect(result.corrections).toEqual([]);
    expect(result.signals.presentFulfillmentOptions).toBe(true);
  });
});
