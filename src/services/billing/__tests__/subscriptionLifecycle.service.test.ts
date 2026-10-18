import { describe, expect, it } from 'vitest';
import {
  classifySubscriptionLifecycle,
  deriveBillingActions,
} from '../subscriptionLifecycle.service';

const FAR_FUTURE = new Date('2999-01-01T00:00:00.000Z');
const FAR_PAST = new Date('2000-01-01T00:00:00.000Z');

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sub-1',
    business_id: 'biz-1',
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_stripe_1',
    stripe_price_id: 'price_1',
    status: 'active',
    cancel_at_period_end: false,
    current_period_start: FAR_PAST,
    current_period_end: FAR_FUTURE,
    plan_id: 'plan-1',
    is_trial: false,
    trial_end: null,
    created_at: FAR_PAST,
    updated_at: FAR_PAST,
    ...overrides,
  } as any;
}

describe('classifySubscriptionLifecycle', () => {
  it('sin fila: "none"', () => {
    expect(classifySubscriptionLifecycle(null)).toBe('none');
  });

  it('fila placeholder sin stripe_subscription_id: "none"', () => {
    expect(classifySubscriptionLifecycle(row({ stripe_subscription_id: null }))).toBe('none');
  });

  it('"active" sin cancelación programada: "active"', () => {
    expect(classifySubscriptionLifecycle(row({ status: 'active' }))).toBe('active');
  });

  it('"trialing": "active"', () => {
    expect(classifySubscriptionLifecycle(row({ status: 'trialing', is_trial: true }))).toBe(
      'active'
    );
  });

  it('"active" con cancelación programada y período vigente: "active_canceling"', () => {
    expect(
      classifySubscriptionLifecycle(
        row({ status: 'active', cancel_at_period_end: true, current_period_end: FAR_FUTURE })
      )
    ).toBe('active_canceling');
  });

  it('"active" con cancelación programada pero período ya terminado: "active" (defensivo, no debería ocurrir en Stripe real)', () => {
    expect(
      classifySubscriptionLifecycle(
        row({ status: 'active', cancel_at_period_end: true, current_period_end: FAR_PAST })
      )
    ).toBe('active');
  });

  it.each(['past_due', 'unpaid', 'incomplete'])('"%s": "past_due"', (status) => {
    expect(classifySubscriptionLifecycle(row({ status }))).toBe('past_due');
  });

  it.each(['canceled', 'cancelled', 'incomplete_expired', 'ended'])('"%s": "expired"', (status) => {
    expect(classifySubscriptionLifecycle(row({ status }))).toBe('expired');
  });

  it('status no contemplado: "unknown", nunca se trata como activo', () => {
    expect(classifySubscriptionLifecycle(row({ status: 'some_future_stripe_status' }))).toBe(
      'unknown'
    );
  });
});

describe('deriveBillingActions', () => {
  it('"none": solo puede iniciar checkout', () => {
    expect(deriveBillingActions('none')).toEqual({
      can_checkout: true,
      can_change_plan: false,
      can_cancel: false,
      can_reactivate: false,
      can_open_portal: false,
      can_upgrade: false,
      can_downgrade: false,
    });
  });

  it('"active": puede cambiar de plan (upgrade o downgrade), cancelar y abrir el portal; no reactivar ni checkout', () => {
    expect(deriveBillingActions('active')).toEqual({
      can_checkout: false,
      can_change_plan: true,
      can_cancel: true,
      can_reactivate: false,
      can_open_portal: true,
      can_upgrade: true,
      can_downgrade: true,
    });
  });

  it('"active_canceling": puede hacer upgrade, reactivar y abrir el portal; NO downgrade (ambiguo con la cancelación programada), no cancelar de nuevo ni checkout', () => {
    expect(deriveBillingActions('active_canceling')).toEqual({
      can_checkout: false,
      can_change_plan: true,
      can_cancel: false,
      can_reactivate: true,
      can_open_portal: true,
      can_upgrade: true,
      can_downgrade: false,
    });
  });

  it('"past_due": solo puede abrir el portal (para regularizar el pago)', () => {
    expect(deriveBillingActions('past_due')).toEqual({
      can_checkout: false,
      can_change_plan: false,
      can_cancel: false,
      can_reactivate: false,
      can_open_portal: true,
      can_upgrade: false,
      can_downgrade: false,
    });
  });

  it('"expired": solo puede iniciar checkout', () => {
    expect(deriveBillingActions('expired')).toEqual({
      can_checkout: true,
      can_change_plan: false,
      can_cancel: false,
      can_reactivate: false,
      can_open_portal: false,
      can_upgrade: false,
      can_downgrade: false,
    });
  });

  it('"unknown": nunca se presenta como activo — ninguna acción salvo checkout', () => {
    expect(deriveBillingActions('unknown')).toEqual({
      can_checkout: true,
      can_change_plan: false,
      can_cancel: false,
      can_reactivate: false,
      can_open_portal: false,
      can_upgrade: false,
      can_downgrade: false,
    });
  });
});
