/**
 * Tests de `cancelOwnerSubscription` y `reactivateSubscription`
 * (stripeCheckout.service.ts) — operaciones owner-facing de ciclo de vida,
 * independientes del controller de super-admin.
 *
 * Desde la Fase 2, ambas funciones corren bajo `withBillingLock` y, antes
 * de decidir, vuelven a pedir el estado remoto actual a Stripe
 * (`reconcileLiveSubscription`) — por eso cada test mockea también ese
 * primer `retrieve` "de reconciliación", además de la mutación en sí.
 * `withBillingLock` se mockea para ejecutar `fn()` directo, sin tocar
 * Postgres real — la garantía de exclusión mutua del lock en sí tiene su
 * propio test (`billingLock.test.ts`), con mocks de `pg`, no de Postgres
 * real (ver ese archivo para la limitación explícita al respecto).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';

const FAR_FUTURE = new Date('2999-01-01T00:00:00.000Z');
const FAR_PAST = new Date('2000-01-01T00:00:00.000Z');
const FAR_FUTURE_SEC = Math.floor(FAR_FUTURE.getTime() / 1000);
const FAR_PAST_SEC = Math.floor(FAR_PAST.getTime() / 1000);
const BUSINESS_ID = 'biz-1';

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sub-row-1',
    business_id: BUSINESS_ID,
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

/** Objeto con la forma de `Stripe.Subscription` que devuelve `retrieve`. */
function remoteSub(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sub_stripe_1',
    customer: 'cus_1',
    schedule: null,
    status: 'active',
    cancel_at_period_end: false,
    current_period_start: FAR_PAST_SEC,
    current_period_end: FAR_FUTURE_SEC,
    ...overrides,
  };
}

vi.mock('../../../lib/prisma', () => {
  const subscription = { findUnique: vi.fn() };
  const tx = { $executeRaw: vi.fn(async () => undefined), subscription };
  return {
    prisma: {
      subscription,
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    },
  };
});

vi.mock('../../../config/env', () => ({
  env: { CORS_ORIGIN: 'https://admin.gesty.online' },
}));

vi.mock('../billingLock', () => ({
  SUBSCRIPTION_LIFECYCLE_NAMESPACE: 'test-namespace',
  withBillingLock: vi.fn(async (_namespace: string, _key: string, fn: () => Promise<unknown>) =>
    fn()
  ),
}));

vi.mock('../planCatalog.service', () => ({
  findActivePlanByCode: vi.fn(),
}));

vi.mock('../stripe.client', () => ({
  getStripe: vi.fn(),
  isStripeConfigured: vi.fn(),
}));

vi.mock('../stripeCustomer.service', () => ({
  getOrCreateStripeCustomerId: vi.fn(),
}));

vi.mock('../stripeSubscriptionSync.service', () => ({
  markSubscriptionDeletedFromStripe: vi.fn(),
  resolveBusinessIdFromStripeSub: vi.fn(),
  upsertSubscriptionFromStripe: vi.fn(async (stripeSub: any, businessId: string) => {
    // Simula el efecto real: persiste lo que Stripe devolvió en la fila local.
    const prismaModule: any = await import('../../../lib/prisma');
    const current = await prismaModule.prisma.subscription.findUnique({
      where: { business_id: businessId },
    });
    const updated = {
      ...(current ?? row()),
      status: stripeSub.status,
      cancel_at_period_end: stripeSub.cancel_at_period_end ?? false,
      updated_at: new Date(),
    };
    prismaModule.prisma.subscription.findUnique.mockResolvedValue(updated);
  }),
}));

import { prisma } from '../../../lib/prisma';
import { getStripe } from '../stripe.client';
import { cancelOwnerSubscription, reactivateSubscription } from '../stripeCheckout.service';

const mockedFindUnique = prisma.subscription.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedGetStripe = getStripe as unknown as ReturnType<typeof vi.fn>;

function fakeStripeClient() {
  return {
    subscriptions: {
      update: vi.fn(),
      retrieve: vi.fn(),
    },
  };
}

describe('cancelOwnerSubscription', () => {
  let stripe: ReturnType<typeof fakeStripeClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    stripe = fakeStripeClient();
    mockedGetStripe.mockReturnValue(stripe);
  });

  it('suscripción "active": reconcilia, programa la cancelación y sincroniza de inmediato', async () => {
    mockedFindUnique.mockResolvedValue(row({ status: 'active', cancel_at_period_end: false }));
    // (1) retrieve de reconciliación bajo el lock, antes de decidir nada.
    stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSub());
    stripe.subscriptions.update.mockResolvedValue(
      remoteSub({ cancel_at_period_end: true })
    );

    const { subscription } = await cancelOwnerSubscription(BUSINESS_ID);

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_stripe_1');
    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      'sub_stripe_1',
      { cancel_at_period_end: true },
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    );
    expect(subscription.cancel_at_period_end).toBe(true);
  });

  it('repetición mientras ya está "active_canceling": idempotente, no vuelve a llamar a `update`', async () => {
    mockedFindUnique.mockResolvedValue(
      row({ status: 'active', cancel_at_period_end: true, current_period_end: FAR_FUTURE })
    );
    stripe.subscriptions.retrieve.mockResolvedValueOnce(
      remoteSub({ cancel_at_period_end: true })
    );

    const { subscription } = await cancelOwnerSubscription(BUSINESS_ID);

    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(subscription.cancel_at_period_end).toBe(true);
  });

  it('rechaza (409) si la reconciliación confirma "past_due": no toca `update`', async () => {
    mockedFindUnique.mockResolvedValue(row({ status: 'past_due' }));
    stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSub({ status: 'past_due' }));

    await expect(cancelOwnerSubscription(BUSINESS_ID)).rejects.toMatchObject({ status: 409 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('rechaza (409) si no hay suscripción vigente ("none") — no llama a Stripe en absoluto', async () => {
    mockedFindUnique.mockResolvedValue(null);

    await expect(cancelOwnerSubscription(BUSINESS_ID)).rejects.toMatchObject({ status: 409 });
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('rechaza (409) si la suscripción remota tiene un schedule asociado (cambio de plan programado) — no cancela por su cuenta', async () => {
    mockedFindUnique.mockResolvedValue(row({ status: 'active', cancel_at_period_end: false }));
    stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSub({ schedule: 'sched_1' }));

    await expect(cancelOwnerSubscription(BUSINESS_ID)).rejects.toMatchObject({ status: 409 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('timeout de Stripe al cancelar: reconcilia por evidencia antes de responder, no asume éxito ni fracaso a ciegas', async () => {
    mockedFindUnique.mockResolvedValue(row({ status: 'active', cancel_at_period_end: false }));
    // (1) reconciliación inicial bajo el lock: todavía sin cancelar.
    stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSub());
    stripe.subscriptions.update.mockRejectedValueOnce(
      new Stripe.errors.StripeConnectionError({ message: 'timeout' } as any)
    );
    // (2) reconciliación POST-error: Stripe sí lo aplicó.
    stripe.subscriptions.retrieve.mockResolvedValueOnce(
      remoteSub({ cancel_at_period_end: true })
    );

    const { subscription } = await cancelOwnerSubscription(BUSINESS_ID);
    expect(subscription.cancel_at_period_end).toBe(true);
  });

  it('timeout de Stripe sin poder reconciliar: responde indeterminado (503), nunca afirma éxito', async () => {
    mockedFindUnique.mockResolvedValue(row({ status: 'active', cancel_at_period_end: false }));
    stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSub());
    stripe.subscriptions.update.mockRejectedValueOnce(
      new Stripe.errors.StripeConnectionError({ message: 'timeout' } as any)
    );
    stripe.subscriptions.retrieve.mockRejectedValueOnce(new Error('still down'));

    await expect(cancelOwnerSubscription(BUSINESS_ID)).rejects.toMatchObject({ status: 503 });
  });
});

describe('reactivateSubscription', () => {
  let stripe: ReturnType<typeof fakeStripeClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    stripe = fakeStripeClient();
    mockedGetStripe.mockReturnValue(stripe);
  });

  it('"active_canceling": deshace la cancelación programada y sincroniza', async () => {
    mockedFindUnique.mockResolvedValue(
      row({ status: 'active', cancel_at_period_end: true, current_period_end: FAR_FUTURE })
    );
    stripe.subscriptions.retrieve.mockResolvedValueOnce(
      remoteSub({ cancel_at_period_end: true })
    );
    stripe.subscriptions.update.mockResolvedValue(
      remoteSub({ cancel_at_period_end: false })
    );

    const { subscription } = await reactivateSubscription(BUSINESS_ID);

    expect(stripe.subscriptions.update).toHaveBeenCalledWith(
      'sub_stripe_1',
      { cancel_at_period_end: false },
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    );
    expect(subscription.cancel_at_period_end).toBe(false);
  });

  it('repetición mientras ya está "active" (sin cancelación pendiente): idempotente, no llama a `update`', async () => {
    mockedFindUnique.mockResolvedValue(row({ status: 'active', cancel_at_period_end: false }));
    stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSub());

    const { subscription } = await reactivateSubscription(BUSINESS_ID);

    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(subscription.cancel_at_period_end).toBe(false);
  });

  it('rechaza (409) una suscripción terminada efectivamente — nunca crea una suscripción nueva como alternativa', async () => {
    mockedFindUnique.mockResolvedValue(row({ status: 'canceled', cancel_at_period_end: false }));
    stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSub({ status: 'canceled' }));

    await expect(reactivateSubscription(BUSINESS_ID)).rejects.toMatchObject({ status: 409 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('rechaza (409) si no hay suscripción ("none")', async () => {
    mockedFindUnique.mockResolvedValue(null);

    await expect(reactivateSubscription(BUSINESS_ID)).rejects.toMatchObject({ status: 409 });
    expect(stripe.subscriptions.retrieve).not.toHaveBeenCalled();
  });

  it('rechaza (409) si la suscripción remota tiene un schedule asociado — no reactiva por su cuenta', async () => {
    mockedFindUnique.mockResolvedValue(
      row({ status: 'active', cancel_at_period_end: true, current_period_end: FAR_FUTURE })
    );
    stripe.subscriptions.retrieve.mockResolvedValueOnce(
      remoteSub({ cancel_at_period_end: true, schedule: 'sched_1' })
    );

    await expect(reactivateSubscription(BUSINESS_ID)).rejects.toMatchObject({ status: 409 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });
});
