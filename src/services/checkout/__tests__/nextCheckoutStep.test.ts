import { describe, expect, it } from 'vitest';
import { nextCheckoutStep } from '../nextCheckoutStep';
import type { CheckoutStepState, CheckoutStepConfig } from '../nextCheckoutStep';

const CONFIG: CheckoutStepConfig = { deliveryEnabled: true, takeawayEnabled: true };

const state = (overrides: Partial<CheckoutStepState> = {}): CheckoutStepState => ({
  fulfillmentType: 'DELIVERY',
  hasAddress: true,
  isInCoverage: true,
  customerName: 'Cliente Test',
  paymentMethod: 'cash',
  ...overrides,
});

describe('nextCheckoutStep', () => {
  it('sin fulfillment → fulfillment', () => {
    expect(nextCheckoutStep(state({ fulfillmentType: null }), CONFIG)).toBe('fulfillment');
  });

  it('DELIVERY sin dirección → address', () => {
    expect(nextCheckoutStep(state({ hasAddress: false }), CONFIG)).toBe('address');
  });

  it('DELIVERY con dirección fuera de cobertura → address', () => {
    expect(nextCheckoutStep(state({ isInCoverage: false }), CONFIG)).toBe('address');
  });

  it('TAKE_AWAY no requiere dirección', () => {
    expect(
      nextCheckoutStep(
        state({ fulfillmentType: 'TAKE_AWAY', hasAddress: false, isInCoverage: false }),
        CONFIG
      )
    ).not.toBe('address');
  });

  it('sin nombre → name', () => {
    expect(nextCheckoutStep(state({ customerName: null }), CONFIG)).toBe('name');
  });

  it('sin método de pago → payment', () => {
    expect(nextCheckoutStep(state({ paymentMethod: null }), CONFIG)).toBe('payment');
  });

  it('método de pago ya elegido → confirm (nunca "done" mientras la sesión sigue activa)', () => {
    expect(nextCheckoutStep(state({ paymentMethod: 'cash' }), CONFIG)).toBe('confirm');
    expect(nextCheckoutStep(state({ paymentMethod: 'online' }), CONFIG)).toBe('confirm');
  });
});
