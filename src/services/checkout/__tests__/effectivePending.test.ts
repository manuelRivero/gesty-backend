import { describe, expect, it } from 'vitest';
import { effectivePending } from '../effectivePending';

describe('effectivePending', () => {
  it('devuelve la acción cuando el snapshot no tiene el campo', () => {
    const result = effectivePending({
      metadata: {
        checkout_pending_action: 'payment_method',
        checkout_pending_question: '¿Cómo querés pagar?',
      },
      snapshot: { fulfillmentType: 'DELIVERY', paymentMethod: null },
    });
    expect(result).toEqual({
      action: 'payment_method',
      question: '¿Cómo querés pagar?',
      stale: false,
      staleReason: null,
    });
  });

  it('marca stale y anula pending si payment_method ya está en el snapshot', () => {
    const result = effectivePending({
      metadata: { checkout_pending_action: 'payment_method' },
      snapshot: { fulfillmentType: 'DELIVERY', paymentMethod: 'cash' },
    });
    expect(result.action).toBeNull();
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe('payment_method_already_in_snapshot');
  });

  it('marca stale y anula pending si fulfillment_type ya está en el snapshot', () => {
    const result = effectivePending({
      metadata: { checkout_pending_action: 'fulfillment_type' },
      snapshot: { fulfillmentType: 'TAKE_AWAY', paymentMethod: null },
    });
    expect(result.action).toBeNull();
    expect(result.stale).toBe(true);
    expect(result.staleReason).toBe('fulfillment_type_already_in_snapshot');
  });

  it('sin checkout_pending_action devuelve null', () => {
    const result = effectivePending({
      metadata: {},
      snapshot: { fulfillmentType: null, paymentMethod: null },
    });
    expect(result).toEqual({
      action: null,
      question: null,
      stale: false,
      staleReason: null,
    });
  });
});
