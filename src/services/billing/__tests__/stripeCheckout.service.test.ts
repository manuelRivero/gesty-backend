/**
 * PLAN-ACCION-SHOPPING-ONLY.md — cobertura de regresión de
 * `stripeCheckout.service.ts` antes de configurar el plan `shopping_only`
 * en Stripe.
 *
 * La auditoría confirmó que `createCheckoutSession` ya exige
 * `plan.is_active=true` (vía `findActivePlanByCode`) y `plan.stripe_price_id`
 * no nulo antes de llamar a Stripe, pero no existía ningún test que lo
 * demostrara. Este archivo cierra esa brecha sin cambiar comportamiento.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    subscription: { findUnique: vi.fn() },
    stripe_webhook_event: { findUnique: vi.fn(), create: vi.fn() },
  },
}));

vi.mock('../../../config/env', () => ({
  env: { CORS_ORIGIN: 'https://admin.gesty.online' },
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

// `stripeCheckout.service.ts` también importa esto a nivel de módulo
// (usado por `processStripeWebhookEvent`, fuera de alcance de este archivo).
vi.mock('../stripeSubscriptionSync.service', () => ({
  markSubscriptionDeletedFromStripe: vi.fn(),
  resolveBusinessIdFromStripeSub: vi.fn(),
  upsertSubscriptionFromStripe: vi.fn(),
}));

import { prisma } from '../../../lib/prisma';
import { findActivePlanByCode } from '../planCatalog.service';
import { getStripe, isStripeConfigured } from '../stripe.client';
import { getOrCreateStripeCustomerId } from '../stripeCustomer.service';
import {
  resolveBusinessIdFromStripeSub,
  upsertSubscriptionFromStripe,
} from '../stripeSubscriptionSync.service';
import { createCheckoutSession, processStripeWebhookEvent } from '../stripeCheckout.service';

const mockedFindPlan = findActivePlanByCode as unknown as ReturnType<typeof vi.fn>;
const mockedGetStripe = getStripe as unknown as ReturnType<typeof vi.fn>;
const mockedIsConfigured = isStripeConfigured as unknown as ReturnType<typeof vi.fn>;
const mockedGetCustomerId = getOrCreateStripeCustomerId as unknown as ReturnType<typeof vi.fn>;
const mockedWebhookEventFindUnique = prisma.stripe_webhook_event
  .findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedWebhookEventCreate = prisma.stripe_webhook_event.create as unknown as ReturnType<
  typeof vi.fn
>;
const mockedResolveBusinessId = resolveBusinessIdFromStripeSub as unknown as ReturnType<
  typeof vi.fn
>;
const mockedUpsertSub = upsertSubscriptionFromStripe as unknown as ReturnType<typeof vi.fn>;

const BUSINESS_ID = 'biz-1';

function fakeStripeClient() {
  return {
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({ url: 'https://checkout.stripe.com/fake-session' }),
      },
    },
  };
}

describe('createCheckoutSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedIsConfigured.mockReturnValue(true);
    mockedGetCustomerId.mockResolvedValue('cus_1');
  });

  it('rechaza (400) sin llamar a Stripe si el plan "shopping_only" todavía no tiene stripe_price_id', async () => {
    const stripe = fakeStripeClient();
    mockedGetStripe.mockReturnValue(stripe);
    mockedFindPlan.mockResolvedValueOnce({
      id: 'plan-shopping-only',
      code: 'shopping_only',
      stripe_price_id: null,
    });

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'shopping_only' })
    ).rejects.toMatchObject({ message: 'Plan no disponible para suscripción', status: 400 });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mockedGetCustomerId).not.toHaveBeenCalled();
  });

  it('rechaza (400) sin llamar a Stripe si el plan no existe o no está activo', async () => {
    const stripe = fakeStripeClient();
    mockedGetStripe.mockReturnValue(stripe);
    mockedFindPlan.mockResolvedValueOnce(null);

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'ghost_plan' })
    ).rejects.toMatchObject({ message: 'Plan no disponible para suscripción', status: 400 });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('rechaza (503) sin consultar el plan si Stripe no está configurado', async () => {
    mockedGetStripe.mockReturnValue(null);
    mockedIsConfigured.mockReturnValue(false);

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'shopping_only' })
    ).rejects.toMatchObject({ message: 'Stripe no configurado', status: 503 });

    expect(mockedFindPlan).not.toHaveBeenCalled();
  });

  it('(regresión) abre Checkout con el price_id del plan cuando sí está disponible', async () => {
    const stripe = fakeStripeClient();
    mockedGetStripe.mockReturnValue(stripe);
    mockedFindPlan.mockResolvedValueOnce({
      id: 'plan-shopping-only',
      code: 'shopping_only',
      stripe_price_id: 'price_shopping_only_test',
    });

    const result = await createCheckoutSession({
      businessId: BUSINESS_ID,
      planCode: 'shopping_only',
    });

    expect(result).toEqual({ url: 'https://checkout.stripe.com/fake-session' });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer: 'cus_1',
        line_items: [{ price: 'price_shopping_only_test', quantity: 1 }],
        metadata: expect.objectContaining({
          business_id: BUSINESS_ID,
          plan_code: 'shopping_only',
        }),
      })
    );
  });
});

describe('processStripeWebhookEvent — idempotencia', () => {
  function subscriptionUpdatedEvent(id: string) {
    return {
      id,
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_stripe_1',
          customer: 'cus_1',
          status: 'active',
          cancel_at_period_end: false,
          metadata: { business_id: BUSINESS_ID },
        },
      },
    } as unknown as Parameters<typeof processStripeWebhookEvent>[0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockedResolveBusinessId.mockResolvedValue(BUSINESS_ID);
    mockedUpsertSub.mockResolvedValue(undefined);
    mockedWebhookEventCreate.mockResolvedValue({});
  });

  it('procesa un evento nuevo: persiste el efecto y marca el evento como procesado', async () => {
    mockedWebhookEventFindUnique.mockResolvedValueOnce(null);

    await processStripeWebhookEvent(subscriptionUpdatedEvent('evt_1'));

    expect(mockedUpsertSub).toHaveBeenCalledTimes(1);
    expect(mockedWebhookEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ stripe_event_id: 'evt_1', type: 'customer.subscription.updated' }),
      })
    );
  });

  it('un evento ya procesado (mismo stripe_event_id) no repite los efectos de persistencia', async () => {
    mockedWebhookEventFindUnique.mockResolvedValueOnce({ id: 'row-1', stripe_event_id: 'evt_1' });

    await processStripeWebhookEvent(subscriptionUpdatedEvent('evt_1'));

    expect(mockedResolveBusinessId).not.toHaveBeenCalled();
    expect(mockedUpsertSub).not.toHaveBeenCalled();
    expect(mockedWebhookEventCreate).not.toHaveBeenCalled();
  });

  it('dos entregas del mismo evento (reintento de Stripe) solo persisten una vez', async () => {
    // Primera entrega: no procesado todavía.
    mockedWebhookEventFindUnique.mockResolvedValueOnce(null);
    await processStripeWebhookEvent(subscriptionUpdatedEvent('evt_retry'));
    expect(mockedUpsertSub).toHaveBeenCalledTimes(1);

    // Segunda entrega (reintento de Stripe con el mismo event.id): ya procesado.
    mockedWebhookEventFindUnique.mockResolvedValueOnce({ id: 'row-1', stripe_event_id: 'evt_retry' });
    await processStripeWebhookEvent(subscriptionUpdatedEvent('evt_retry'));

    expect(mockedUpsertSub).toHaveBeenCalledTimes(1);
    expect(mockedWebhookEventCreate).toHaveBeenCalledTimes(1);
  });
});
