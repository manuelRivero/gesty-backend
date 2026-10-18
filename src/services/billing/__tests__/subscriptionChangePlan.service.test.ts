/**
 * Tests de `changeSubscriptionPlan` (subscriptionChangePlan.service.ts):
 * upgrade inmediato con prorrateo, downgrade programado vía Subscription
 * Schedule, y las validaciones compartidas (planes inválidos, mismo plan,
 * estados incompatibles, orden ambiguo entre planes con capacidades
 * distintas).
 *
 * Desde la Fase 2, toda la función corre bajo `withBillingLock` (mockeado
 * acá para ejecutar `fn()` directo, sin Postgres real — ver
 * `billingLock.test.ts` para el test del lock en sí) y, antes de decidir,
 * vuelve a pedir el estado remoto actual a Stripe
 * (`reconcileLiveSubscription`): eso agrega DOS lecturas de
 * `prisma.subscription.findUnique` (la local + la posterior al upsert de
 * reconciliación) antes de cualquier lectura "final" que ya existiera. En
 * los tests donde el plan NO cambia entre el estado inicial y el final
 * (todo el bloque de downgrade, los rechazos tempranos) esas dos lecturas
 * de más devuelven el mismo valor, así que no hace falta tocar nada; en
 * los tests de upgrade donde el plan SÍ cambia, se ajustó la secuencia de
 * `mockResolvedValueOnce`/`mockResolvedValue` para reflejar el orden real:
 * reconcile (x2, estado ANTES del cambio) → mutación → lectura final (el
 * valor por default de `mockResolvedValue`, DESPUÉS del cambio).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';

const FAR_FUTURE = new Date('2999-01-01T00:00:00.000Z');
const FAR_PAST = new Date('2000-01-01T00:00:00.000Z');
const BUSINESS_ID = 'biz-1';
const FAR_FUTURE_SEC = Math.floor(FAR_FUTURE.getTime() / 1000);
const FAR_PAST_SEC = Math.floor(FAR_PAST.getTime() / 1000);

function subRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sub-row-1',
    business_id: BUSINESS_ID,
    stripe_customer_id: 'cus_1',
    stripe_subscription_id: 'sub_stripe_1',
    stripe_price_id: 'price_basic',
    status: 'active',
    cancel_at_period_end: false,
    current_period_start: FAR_PAST,
    current_period_end: FAR_FUTURE,
    plan_id: 'plan-basic',
    is_trial: false,
    trial_end: null,
    created_at: FAR_PAST,
    updated_at: FAR_PAST,
    ...overrides,
  } as any;
}

// Capacidades reales del catálogo (ver `src/constants/planCatalog.ts`):
// basic/pro comparten ai_enabled+shopping_enabled, solo difieren en cuota y
// precio — comparables por precio. shopping_only tiene ai_enabled=false:
// lo domina cualquiera de los otros tres en todos los ejes.
const PLAN_BASIC = {
  id: 'plan-basic',
  code: 'basic',
  monthly_price_usd: '45.00',
  stripe_price_id: 'price_basic',
  ai_enabled: true,
  shopping_enabled: true,
  token_limit: 2500,
};
const PLAN_PRO = {
  id: 'plan-pro',
  code: 'pro',
  monthly_price_usd: '95.00',
  stripe_price_id: 'price_pro',
  ai_enabled: true,
  shopping_enabled: true,
  token_limit: 7000,
};
const PLAN_SHOPPING_ONLY = {
  id: 'plan-shopping',
  code: 'shopping_only',
  monthly_price_usd: '15.00',
  stripe_price_id: 'price_shopping',
  ai_enabled: false,
  shopping_enabled: true,
  token_limit: 0,
};
// Plan hipotético sin Shopping pero con más cuota de IA que `basic` — ni
// domina a `basic` ni es dominado por él (gana en IA, pierde en Shopping),
// así que el orden entre ambos es ambiguo a propósito, para testear que
// `changeSubscriptionPlan` lo rechaza en vez de adivinar.
const PLAN_AI_ONLY_HIGH = {
  id: 'plan-ai-only-high',
  code: 'ai_only_high',
  monthly_price_usd: '50.00',
  stripe_price_id: 'price_ai_only_high',
  ai_enabled: true,
  shopping_enabled: false,
  token_limit: 5000,
};

vi.mock('../../../lib/prisma', () => {
  const subscription = { findUnique: vi.fn() };
  const plan = { findUnique: vi.fn() };
  const tx = { $executeRaw: vi.fn(async () => undefined), subscription };
  return {
    prisma: {
      subscription,
      plan,
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    },
  };
});

vi.mock('../billingLock', () => ({
  SUBSCRIPTION_LIFECYCLE_NAMESPACE: 'test-namespace',
  withBillingLock: vi.fn(async (_namespace: string, _key: string, fn: () => Promise<unknown>) =>
    fn()
  ),
}));

vi.mock('../stripe.client', () => ({
  getStripe: vi.fn(),
  isStripeConfigured: vi.fn(() => true),
}));

vi.mock('../planCatalog.service', () => ({
  findActivePlanByCode: vi.fn(),
}));

vi.mock('../stripeSubscriptionSync.service', () => ({
  upsertSubscriptionFromStripe: vi.fn(),
}));

import { prisma } from '../../../lib/prisma';
import { getStripe } from '../stripe.client';
import { findActivePlanByCode } from '../planCatalog.service';
import { upsertSubscriptionFromStripe } from '../stripeSubscriptionSync.service';
import { changeSubscriptionPlan } from '../subscriptionChangePlan.service';

const mockedSubFindUnique = prisma.subscription.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedPlanFindUnique = prisma.plan.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedGetStripe = getStripe as unknown as ReturnType<typeof vi.fn>;
const mockedFindActivePlanByCode = findActivePlanByCode as unknown as ReturnType<typeof vi.fn>;
const mockedUpsertSub = upsertSubscriptionFromStripe as unknown as ReturnType<typeof vi.fn>;

function fakeStripeClient() {
  return {
    subscriptions: {
      retrieve: vi.fn(),
      update: vi.fn(),
    },
    subscriptionSchedules: {
      create: vi.fn(),
      update: vi.fn(),
      retrieve: vi.fn(),
      release: vi.fn(),
    },
  };
}

function remoteSubscription(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sub_stripe_1',
    schedule: null,
    items: { data: [{ id: 'si_1', price: { id: 'price_basic' }, quantity: 1 }] },
    status: 'active',
    cancel_at_period_end: false,
    ...overrides,
  };
}

describe('changeSubscriptionPlan', () => {
  let stripe: ReturnType<typeof fakeStripeClient>;

  beforeEach(() => {
    vi.resetAllMocks();
    stripe = fakeStripeClient();
    mockedGetStripe.mockReturnValue(stripe);
    mockedPlanFindUnique.mockImplementation(async ({ where }: any) => {
      if (where.id === PLAN_BASIC.id) return PLAN_BASIC;
      if (where.id === PLAN_PRO.id) return PLAN_PRO;
      if (where.id === PLAN_SHOPPING_ONLY.id) return PLAN_SHOPPING_ONLY;
      if (where.id === PLAN_AI_ONLY_HIGH.id) return PLAN_AI_ONLY_HIGH;
      return null;
    });
  });

  it('rechaza (400) un plan de destino inexistente/inactivo', async () => {
    mockedFindActivePlanByCode.mockResolvedValueOnce(null);

    await expect(
      changeSubscriptionPlan(BUSINESS_ID, 'ghost_plan')
    ).rejects.toMatchObject({ status: 400 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('rechaza (400) un cambio al mismo plan actual', async () => {
    mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_BASIC);
    mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_BASIC.id }));

    await expect(changeSubscriptionPlan(BUSINESS_ID, 'basic')).rejects.toMatchObject({
      status: 400,
    });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('rechaza (409) si no hay suscripción vigente ("none")', async () => {
    mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_PRO);
    mockedSubFindUnique.mockResolvedValue(null);

    await expect(changeSubscriptionPlan(BUSINESS_ID, 'pro')).rejects.toMatchObject({
      status: 409,
    });
  });

  it('rechaza (409) un cambio de plan con pago pendiente ("past_due") — no lo ejecuta automáticamente', async () => {
    mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_PRO);
    mockedSubFindUnique.mockResolvedValue(subRow({ status: 'past_due', plan_id: PLAN_BASIC.id }));

    await expect(changeSubscriptionPlan(BUSINESS_ID, 'pro')).rejects.toMatchObject({
      status: 409,
    });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it('rechaza (409) un cambio entre planes sin orden definido (capacidades distintas, ninguno domina al otro) — no adivina si es upgrade o downgrade', async () => {
    mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_AI_ONLY_HIGH);
    mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_BASIC.id }));

    await expect(
      changeSubscriptionPlan(BUSINESS_ID, 'ai_only_high')
    ).rejects.toMatchObject({ status: 409 });
    expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
  });

  describe('upgrade inmediato', () => {
    it('basic → pro: modifica la suscripción existente con proration_behavior "always_invoice", confirma el pago por evidencia de la factura, sin crear Checkout Session', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_PRO);
      // Lecturas: (1-2) reconcile bajo el lock, estado ANTES del upgrade
      // (basic) → (3) lectura final, ya en pro (fallback por default).
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_BASIC.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_BASIC.id }));
      stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSubscription());
      stripe.subscriptions.update.mockResolvedValueOnce(
        remoteSubscription({
          items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, quantity: 1 }] },
          latest_invoice: { status: 'paid' },
        })
      );

      const result = await changeSubscriptionPlan(BUSINESS_ID, 'pro');

      expect(result.billing).toBe('immediate_paid');
      expect(stripe.subscriptions.update).toHaveBeenCalledWith(
        'sub_stripe_1',
        expect.objectContaining({
          items: [{ id: 'si_1', price: 'price_pro', quantity: 1 }],
          proration_behavior: 'always_invoice',
          expand: ['latest_invoice.payment_intent'],
        }),
        expect.objectContaining({ idempotencyKey: expect.any(String) })
      );
      expect(mockedUpsertSub).toHaveBeenCalledTimes(2); // reconcile + mutación
      expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    });

    it('basic → pro con la factura de prorrata todavía sin confirmar como pagada: informa "immediate_payment_pending", nunca "immediate_paid" sin evidencia', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_PRO);
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_BASIC.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_BASIC.id }));
      stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSubscription());
      stripe.subscriptions.update.mockResolvedValueOnce(
        remoteSubscription({
          items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, quantity: 1 }] },
          // Factura abierta (no pagada) — ej. 3DS pendiente, cobro async.
          latest_invoice: { status: 'open' },
        })
      );

      const result = await changeSubscriptionPlan(BUSINESS_ID, 'pro');
      expect(result.billing).toBe('immediate_payment_pending');
    });

    it('basic → pro sin factura expandida en la respuesta: nunca informa "immediate_paid" sin evidencia', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_PRO);
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_BASIC.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_BASIC.id }));
      stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSubscription());
      // Sin `latest_invoice` en absoluto (ej. SDK/versión que no lo expandió).
      stripe.subscriptions.update.mockResolvedValueOnce(
        remoteSubscription({ items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, quantity: 1 }] } })
      );

      const result = await changeSubscriptionPlan(BUSINESS_ID, 'pro');
      expect(result.billing).toBe('immediate_payment_pending');
    });

    it('basic → pro cuya respuesta de Stripe deja la suscripción en "past_due" (la prorrata falló): nunca informa "immediate_paid"', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_PRO);
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_BASIC.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_BASIC.id }));
      stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSubscription());
      stripe.subscriptions.update.mockResolvedValueOnce(
        remoteSubscription({
          items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, quantity: 1 }] },
          status: 'past_due',
          latest_invoice: { status: 'open' },
        })
      );

      const result = await changeSubscriptionPlan(BUSINESS_ID, 'pro');
      expect(result.billing).toBe('immediate_payment_pending');
    });

    it('si existe un downgrade programado (schedule) y se pide un upgrade: libera el schedule antes de aplicar el upgrade', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_PRO);
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_SHOPPING_ONLY.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_SHOPPING_ONLY.id }));
      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        remoteSubscription({ schedule: 'sched_1' })
      );
      stripe.subscriptionSchedules.release.mockResolvedValueOnce({ id: 'sched_1' });
      stripe.subscriptions.update.mockResolvedValueOnce(remoteSubscription());

      await changeSubscriptionPlan(BUSINESS_ID, 'pro');

      expect(stripe.subscriptionSchedules.release).toHaveBeenCalledWith(
        'sched_1',
        undefined,
        expect.objectContaining({ idempotencyKey: expect.any(String) })
      );
      expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1);
    });

    it('timeout de Stripe al aplicar el upgrade: reconcilia por evidencia y confirma si el plan ya cambió — sin evidencia de pago, informa "immediate_payment_pending"', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_PRO);
      // (1-2) reconcile inicial (basic) → (3) reconcileFromRemote tras el
      // timeout, muestra que el plan sí quedó en "pro".
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_BASIC.id }));
      mockedSubFindUnique.mockResolvedValueOnce(subRow({ plan_id: PLAN_BASIC.id }));
      stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSubscription());
      stripe.subscriptions.update.mockRejectedValueOnce(
        new Stripe.errors.StripeConnectionError({ message: 'timeout' } as any)
      );

      const result = await changeSubscriptionPlan(BUSINESS_ID, 'pro');
      expect(result.billing).toBe('immediate_payment_pending');
    });

    it('timeout de Stripe sin evidencia de que se haya aplicado: responde indeterminado (503), no afirma éxito', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_PRO);
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_BASIC.id }));
      stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSubscription());
      stripe.subscriptions.update.mockRejectedValueOnce(
        new Stripe.errors.StripeConnectionError({ message: 'timeout' } as any)
      );
      // La reconciliación muestra que el plan sigue en "basic" (no se aplicó).

      await expect(changeSubscriptionPlan(BUSINESS_ID, 'pro')).rejects.toMatchObject({
        status: 503,
      });
    });
  });

  describe('downgrade programado', () => {
    it('pro → basic: crea un Subscription Schedule con la fase vigente intacta y el plan nuevo recién al fin del período — no reduce accesos de inmediato', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_BASIC);
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id, stripe_price_id: 'price_pro' }));
      stripe.subscriptions.retrieve
        .mockResolvedValueOnce(remoteSubscription({ items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, quantity: 1 }] } }))
        .mockResolvedValueOnce(remoteSubscription({ items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, quantity: 1 }] } }));
      stripe.subscriptionSchedules.create.mockResolvedValueOnce({
        id: 'sched_new',
        phases: [{ start_date: FAR_PAST_SEC, end_date: FAR_FUTURE_SEC, items: [{ price: 'price_pro', quantity: 1 }] }],
      });
      stripe.subscriptionSchedules.update.mockResolvedValueOnce({
        id: 'sched_new',
        subscription: 'sub_stripe_1',
      });

      const result = await changeSubscriptionPlan(BUSINESS_ID, 'basic');

      expect(result.billing).toBe('scheduled');
      expect(stripe.subscriptionSchedules.create).toHaveBeenCalledWith(
        { from_subscription: 'sub_stripe_1' },
        expect.objectContaining({ idempotencyKey: expect.any(String) })
      );
      const updateCall = stripe.subscriptionSchedules.update.mock.calls[0];
      expect(updateCall[1].phases).toHaveLength(2);
      expect(updateCall[1].phases[0]).toMatchObject({
        items: [{ price: 'price_pro', quantity: 1 }],
        start_date: FAR_PAST_SEC,
        end_date: FAR_FUTURE_SEC,
        proration_behavior: 'none',
      });
      expect(updateCall[1].phases[1]).toMatchObject({
        items: [{ price: 'price_basic', quantity: 1 }],
        start_date: FAR_FUTURE_SEC,
      });
      // El downgrade NO modifica directamente la suscripción — nunca llama
      // a `subscriptions.update` con items, ni crea un Checkout Session.
      expect(stripe.subscriptions.update).not.toHaveBeenCalled();
    });

    it('pro → basic con la fase vigente con descuentos, impuestos y metadata configurados: los preserva tal cual en el payload de `subscriptionSchedules.update`, convirtiendo objetos expandidos a ids', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_BASIC);
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id, stripe_price_id: 'price_pro' }));
      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        remoteSubscription({ items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, quantity: 1 }] } })
      );
      stripe.subscriptionSchedules.create.mockResolvedValueOnce({
        id: 'sched_new',
        phases: [
          {
            start_date: FAR_PAST_SEC,
            end_date: FAR_FUTURE_SEC,
            proration_behavior: 'none',
            // Item con descuento e impuesto EXPANDIDOS (objetos completos,
            // no ids) y metadata no vacía.
            items: [
              {
                price: { id: 'price_pro' }, // objeto expandido, no string
                quantity: 2,
                discounts: [{ coupon: { id: 'coupon_abc' }, discount: null, promotion_code: null }],
                tax_rates: [{ id: 'txr_123' }],
                metadata: { seat: 'main' },
              },
            ],
            // Descuento e impuesto a nivel de FASE, también expandidos.
            discounts: [{ coupon: null, discount: { id: 'di_existing' }, promotion_code: null }],
            default_tax_rates: [{ id: 'txr_default' }],
            automatic_tax: { enabled: true, disabled_reason: null, liability: { type: 'self' } },
            metadata: { campaign: 'q4' },
            collection_method: 'charge_automatically',
          },
        ],
      });
      stripe.subscriptionSchedules.update.mockResolvedValueOnce({
        id: 'sched_new',
        subscription: 'sub_stripe_1',
      });
      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        remoteSubscription({ items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, quantity: 1 }] } })
      );

      await changeSubscriptionPlan(BUSINESS_ID, 'basic');

      const updateCall = stripe.subscriptionSchedules.update.mock.calls[0];
      const preservedPhase = updateCall[1].phases[0];

      expect(preservedPhase.items).toEqual([
        {
          price: 'price_pro', // convertido a id de escritura
          quantity: 2,
          discounts: [{ coupon: 'coupon_abc' }],
          tax_rates: ['txr_123'],
          metadata: { seat: 'main' },
        },
      ]);
      expect(preservedPhase.discounts).toEqual([{ discount: 'di_existing' }]);
      expect(preservedPhase.default_tax_rates).toEqual(['txr_default']);
      expect(preservedPhase.automatic_tax).toEqual({ enabled: true, liability: { type: 'self' } });
      expect(preservedPhase.metadata).toEqual({ campaign: 'q4' });
      expect(preservedPhase.collection_method).toBe('charge_automatically');
    });

    it('pro → basic con la fase vigente usando `transfer_data` (configuración avanzada no soportada todavía): rechaza (409) en vez de perder esa configuración en silencio', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_BASIC);
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id, stripe_price_id: 'price_pro' }));
      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        remoteSubscription({ items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, quantity: 1 }] } })
      );
      stripe.subscriptionSchedules.create.mockResolvedValueOnce({
        id: 'sched_new',
        phases: [
          {
            start_date: FAR_PAST_SEC,
            end_date: FAR_FUTURE_SEC,
            items: [{ price: 'price_pro', quantity: 1 }],
            transfer_data: { destination: 'acct_connected_1' },
          },
        ],
      });

      await expect(changeSubscriptionPlan(BUSINESS_ID, 'basic')).rejects.toMatchObject({
        status: 409,
      });
      expect(stripe.subscriptionSchedules.update).not.toHaveBeenCalled();
    });

    it('si ya existe un downgrade programado (schedule) y se pide otro: reemplaza las fases en vez de crear un segundo schedule', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_BASIC);
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id, stripe_price_id: 'price_pro' }));
      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        remoteSubscription({
          schedule: 'sched_existing',
          items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, quantity: 1 }] },
        })
      );
      stripe.subscriptionSchedules.retrieve.mockResolvedValueOnce({
        id: 'sched_existing',
        phases: [
          { start_date: FAR_PAST_SEC, end_date: FAR_FUTURE_SEC, items: [{ price: 'price_pro', quantity: 1 }] },
          { start_date: FAR_FUTURE_SEC, end_date: FAR_FUTURE_SEC + 2592000, items: [{ price: 'price_shopping', quantity: 1 }] },
        ],
      });
      stripe.subscriptionSchedules.update.mockResolvedValueOnce({
        id: 'sched_existing',
        subscription: 'sub_stripe_1',
      });

      await changeSubscriptionPlan(BUSINESS_ID, 'basic');

      expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
      const updateCall = stripe.subscriptionSchedules.update.mock.calls[0];
      // La fase nueva apunta al plan recién pedido (basic), no al que había
      // quedado programado antes (shopping_only) — se reemplazó, no se
      // agregó una tercera fase.
      expect(updateCall[1].phases[1].items).toEqual([{ price: 'price_basic', quantity: 1 }]);
      expect(updateCall[1].phases).toHaveLength(2);
    });

    it('rechaza (409) programar un downgrade mientras hay una cancelación programada vigente — no cancela ni reactiva por su cuenta', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_BASIC);
      mockedSubFindUnique.mockResolvedValue(
        subRow({
          plan_id: PLAN_PRO.id,
          cancel_at_period_end: true,
          current_period_end: FAR_FUTURE,
        })
      );

      await expect(changeSubscriptionPlan(BUSINESS_ID, 'basic')).rejects.toMatchObject({
        status: 409,
      });
      expect(stripe.subscriptionSchedules.create).not.toHaveBeenCalled();
    });

    it('upgrade SÍ se permite mientras hay una cancelación programada (no se confunde con un downgrade)', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_PRO);
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id }));
      mockedSubFindUnique.mockResolvedValueOnce(
        subRow({
          plan_id: PLAN_BASIC.id,
          cancel_at_period_end: true,
          current_period_end: FAR_FUTURE,
        })
      );
      mockedSubFindUnique.mockResolvedValueOnce(
        subRow({
          plan_id: PLAN_BASIC.id,
          cancel_at_period_end: true,
          current_period_end: FAR_FUTURE,
        })
      );
      stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSubscription());
      stripe.subscriptions.update.mockResolvedValueOnce(remoteSubscription());

      const result = await changeSubscriptionPlan(BUSINESS_ID, 'pro');
      expect(result.billing).toBe('immediate_payment_pending');
    });

    it('timeout de Stripe al actualizar el schedule: responde indeterminado, no afirma que el downgrade quedó programado', async () => {
      mockedFindActivePlanByCode.mockResolvedValueOnce(PLAN_BASIC);
      mockedSubFindUnique.mockResolvedValue(subRow({ plan_id: PLAN_PRO.id, stripe_price_id: 'price_pro' }));
      stripe.subscriptions.retrieve.mockResolvedValueOnce(
        remoteSubscription({ items: { data: [{ id: 'si_1', price: { id: 'price_pro' }, quantity: 1 }] } })
      );
      stripe.subscriptionSchedules.create.mockResolvedValueOnce({
        id: 'sched_new',
        phases: [{ start_date: FAR_PAST_SEC, end_date: FAR_FUTURE_SEC, items: [{ price: 'price_pro', quantity: 1 }] }],
      });
      stripe.subscriptionSchedules.update.mockRejectedValueOnce(
        new Stripe.errors.StripeConnectionError({ message: 'timeout' } as any)
      );
      stripe.subscriptions.retrieve.mockResolvedValueOnce(remoteSubscription());

      await expect(changeSubscriptionPlan(BUSINESS_ID, 'basic')).rejects.toMatchObject({
        status: 503,
      });
    });
  });
});
