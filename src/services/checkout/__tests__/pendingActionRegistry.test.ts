import { describe, expect, it } from 'vitest';
import {
  getCheckoutPendingActionConfig,
  PaymentMethodPendingSchema,
  ConfirmOrderPendingSchema,
} from '../pendingActionRegistry';

describe('pendingActionRegistry', () => {
  it('resuelve payment_method con schema y hints', () => {
    const config = getCheckoutPendingActionConfig('payment_method');
    expect(config).not.toBeNull();
    expect(config?.pendingAction).toBe('payment_method');
    expect(config?.defaultQuestion.length).toBeGreaterThan(0);
    expect(config?.valueHints).toContain('cash');
    expect(config?.valueHints).toContain('online');
    const parsed = config!.schema.safeParse({ method: 'cash' });
    expect(parsed.success).toBe(true);
  });

  it('resuelve fulfillment_type con schema y pregunta alineada', () => {
    const config = getCheckoutPendingActionConfig('fulfillment_type');
    expect(config?.pendingAction).toBe('fulfillment_type');
    expect(config?.defaultQuestion).toContain('recibir tu pedido');
    expect(config?.schema.safeParse({ type: 'DELIVERY' }).success).toBe(true);
    expect(config?.schema.safeParse({ type: 'TAKE_AWAY' }).success).toBe(true);
  });

  it('resuelve confirm_order con schema y pregunta alineada', () => {
    const config = getCheckoutPendingActionConfig('confirm_order');
    expect(config?.pendingAction).toBe('confirm_order');
    expect(config?.defaultQuestion).toContain('Confirmás');
    expect(config?.schema.safeParse({ confirmed: true }).success).toBe(true);
    expect(config?.schema.safeParse({ confirmed: false }).success).toBe(true);
    expect(config?.schema.safeParse({}).success).toBe(false);
  });

  it('retorna null para acción desconocida', () => {
    expect(getCheckoutPendingActionConfig('unknown')).toBeNull();
  });

  it('PaymentMethodPendingSchema rechaza valores inválidos', () => {
    expect(PaymentMethodPendingSchema.safeParse({ method: 'cash' }).success).toBe(true);
    expect(PaymentMethodPendingSchema.safeParse({}).success).toBe(false);
  });

  it('ConfirmOrderPendingSchema rechaza valores inválidos', () => {
    expect(ConfirmOrderPendingSchema.safeParse({ confirmed: true }).success).toBe(true);
    expect(ConfirmOrderPendingSchema.safeParse({ confirmed: 'yes' }).success).toBe(false);
  });
});
