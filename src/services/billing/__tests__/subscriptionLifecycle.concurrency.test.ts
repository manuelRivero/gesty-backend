/**
 * Cierra la brecha señalada por la auditoría de Fase 2: los tests de
 * `cancelOwnerSubscription`/`reactivateSubscription`/`changeSubscriptionPlan`
 * existentes mockean `../billingLock` para ejecutar `fn()` directo —
 * prueban la lógica de negocio aislada, pero NO demuestran que dos
 * llamadas reales se serializan entre sí.
 *
 * Este archivo NO mockea `../billingLock`: importa la implementación REAL
 * (`withBillingLock`) y mockea únicamente `pg` por debajo, con semántica de
 * advisory lock de sesión fiel (un Map de claves tomadas, compartido entre
 * "conexiones" — exactamente lo que en Postgres real harían dos sesiones
 * compitiendo por el mismo `pg_try_advisory_lock`). Las funciones de
 * negocio (`cancelOwnerSubscription`, `reactivateSubscription`,
 * `changeSubscriptionPlan`) también son las reales, sin mockear.
 *
 * LÍMITE EXPLÍCITO: esto prueba la lógica de `withBillingLock` (adquisición,
 * espera, liberación, y que el código de negocio decide sobre el estado
 * posterior a la primera operación) con una implementación de `pg`
 * controlada en el mismo proceso — NO contra dos conexiones TCP reales a un
 * Postgres real. Confirmé (sesión anterior) que no hay Postgres accesible
 * en este entorno (sin Docker, sin `psql` local) — no se instaló nada para
 * evitar cambiar infraestructura fuera de alcance. La prueba de integración
 * contra PostgreSQL real sigue pendiente, igual que para `checkout_attempt`
 * (`checkoutAttempt.postgres.integration.test.ts`, también sin ejecutar acá).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const FAR_FUTURE = new Date('2999-01-01T00:00:00.000Z');
const FAR_PAST = new Date('2000-01-01T00:00:00.000Z');
const FAR_FUTURE_SEC = Math.floor(FAR_FUTURE.getTime() / 1000);
const FAR_PAST_SEC = Math.floor(FAR_PAST.getTime() / 1000);
const BUSINESS_ID = 'biz-1';

// --- Fake `pg` con semántica real de advisory lock de sesión, compartida
// entre todas las "conexiones" que el test abra (igual que Postgres real
// comparte el espacio de advisory locks entre sesiones de la misma base).
const heldLockKeys = new Set<string>();

vi.mock('pg', () => {
  class FakePoolClient {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('pg_try_advisory_lock')) {
        const k = (params ?? []).join(':');
        if (heldLockKeys.has(k)) return { rows: [{ locked: false }] };
        heldLockKeys.add(k);
        return { rows: [{ locked: true }] };
      }
      if (sql.includes('pg_advisory_unlock')) {
        const k = (params ?? []).join(':');
        heldLockKeys.delete(k);
        return { rows: [{ unlocked: true }] };
      }
      throw new Error(`fake pg: query inesperada: ${sql}`);
    }
    release() {
      // no-op: no hay pool real que devolver.
    }
  }
  class FakePool {
    connect() {
      return Promise.resolve(new FakePoolClient());
    }
    on() {}
    end() {
      return Promise.resolve();
    }
  }
  return { Pool: FakePool };
});

vi.mock('../../../config/env', () => ({
  env: { DATABASE_URL: 'postgres://fake', CORS_ORIGIN: 'https://admin.gesty.online' },
}));

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

const PLAN_BASIC = { id: 'plan-basic', code: 'basic', monthly_price_usd: '45.00', stripe_price_id: 'price_basic', ai_enabled: true, shopping_enabled: true, token_limit: 2500 };
const PLAN_PRO = { id: 'plan-pro', code: 'pro', monthly_price_usd: '95.00', stripe_price_id: 'price_pro', ai_enabled: true, shopping_enabled: true, token_limit: 7000 };
const PLAN_BUSINESS = { id: 'plan-business', code: 'business', monthly_price_usd: '195.00', stripe_price_id: 'price_business', ai_enabled: true, shopping_enabled: true, token_limit: 20000 };
const PLANS_BY_ID: Record<string, typeof PLAN_BASIC> = {
  [PLAN_BASIC.id]: PLAN_BASIC,
  [PLAN_PRO.id]: PLAN_PRO,
  [PLAN_BUSINESS.id]: PLAN_BUSINESS,
};
const PLANS_BY_PRICE: Record<string, typeof PLAN_BASIC> = {
  [PLAN_BASIC.stripe_price_id]: PLAN_BASIC,
  [PLAN_PRO.stripe_price_id]: PLAN_PRO,
  [PLAN_BUSINESS.stripe_price_id]: PLAN_BUSINESS,
};

// --- Estado compartido "del lado de Stripe": una única suscripción remota,
// mutada por `subscriptions.update` y leída por `subscriptions.retrieve` —
// así la segunda operación de cada test ve genuinamente lo que la primera
// ya aplicó, en vez de una copia estática.
let remoteSubState: any;
function resetRemoteSub(overrides: Partial<Record<string, unknown>> = {}) {
  remoteSubState = {
    id: 'sub_stripe_1',
    customer: 'cus_1',
    schedule: null,
    status: 'active',
    cancel_at_period_end: false,
    current_period_start: FAR_PAST_SEC,
    current_period_end: FAR_FUTURE_SEC,
    items: { data: [{ id: 'si_1', price: { id: 'price_basic' }, quantity: 1 }] },
    latest_invoice: { status: 'paid' },
    ...overrides,
  };
}

// --- Estado compartido "local": lo que `prisma.subscription.findUnique`
// devuelve, mutado por el mock de `upsertSubscriptionFromStripe` (igual que
// la función real persiste lo que Stripe acaba de confirmar).
let localSubState: any;

vi.mock('../../../lib/prisma', () => {
  const subscription = {
    findUnique: vi.fn(async () => localSubState),
  };
  const plan = {
    findUnique: vi.fn(async ({ where }: any) => PLANS_BY_ID[where.id] ?? null),
  };
  const tx = { $executeRaw: vi.fn(async () => undefined), subscription };
  const stripe_webhook_event = {
    findUnique: vi.fn(async () => null),
    create: vi.fn(async () => ({})),
  };
  return {
    prisma: {
      subscription,
      plan,
      stripe_webhook_event,
      $transaction: vi.fn(async (fn: any) => fn(tx)),
    },
  };
});

vi.mock('../stripe.client', () => ({
  getStripe: vi.fn(),
  isStripeConfigured: vi.fn(() => true),
}));

vi.mock('../planCatalog.service', () => ({
  findActivePlanByCode: vi.fn(async (code: string) =>
    [PLAN_BASIC, PLAN_PRO, PLAN_BUSINESS].find((p) => p.code === code) ?? null
  ),
}));

vi.mock('../stripeCustomer.service', () => ({
  getOrCreateStripeCustomerId: vi.fn(async () => 'cus_1'),
}));

vi.mock('../stripeSubscriptionSync.service', () => ({
  markSubscriptionDeletedFromStripe: vi.fn(),
  resolveBusinessIdFromStripeSub: vi.fn(async () => BUSINESS_ID),
  // Mock con el MISMO efecto observable que la función real: persiste en
  // `localSubState` lo que Stripe devolvió, resolviendo `plan_id` a partir
  // del price_id (igual que `stripeSubscriptionSync.service.ts` real).
  upsertSubscriptionFromStripe: vi.fn(async (stripeSub: any) => {
    const priceId = stripeSub.items?.data?.[0]?.price?.id ?? stripeSub.items?.data?.[0]?.price;
    const plan = typeof priceId === 'string' ? PLANS_BY_PRICE[priceId] : null;
    localSubState = {
      ...localSubState,
      status: stripeSub.status,
      cancel_at_period_end: stripeSub.cancel_at_period_end ?? false,
      plan_id: plan?.id ?? localSubState.plan_id,
      stripe_price_id: typeof priceId === 'string' ? priceId : localSubState.stripe_price_id,
      updated_at: new Date(),
    };
  }),
}));

import { getStripe } from '../stripe.client';
import {
  cancelOwnerSubscription,
  processStripeWebhookEvent,
  reactivateSubscription,
} from '../stripeCheckout.service';
import { changeSubscriptionPlan } from '../subscriptionChangePlan.service';

const mockedGetStripe = getStripe as unknown as ReturnType<typeof vi.fn>;

/** Promesa controlable manualmente — para forzar el orden real de la carrera. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('Concurrencia real entre operaciones de ciclo de vida (withBillingLock sin mockear)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    heldLockKeys.clear();
    resetRemoteSub();
    localSubState = subRow();
  });

  it('cancelOwnerSubscription vs. reactivateSubscription: la segunda decide sobre el estado que dejó la primera, no sobre el estado inicial', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn(async () => ({ ...remoteSubState })),
        update: vi.fn(),
      },
    };
    mockedGetStripe.mockReturnValue(stripe);

    const order: string[] = [];
    const gate = deferred<void>();

    // La mutación de `cancelOwnerSubscription` queda "en vuelo" hasta que el
    // test suelte la compuerta — simula la llamada de red a Stripe tardando,
    // con el lock ya tomado.
    stripe.subscriptions.update.mockImplementationOnce(async (_id: string, params: any) => {
      order.push('cancel-update-start');
      await gate.promise;
      remoteSubState = { ...remoteSubState, cancel_at_period_end: params.cancel_at_period_end };
      order.push('cancel-update-end');
      return { ...remoteSubState };
    });
    // Llamada a `update` de `reactivateSubscription` (la segunda en
    // dispararse) — resuelve normal, sin compuerta.
    stripe.subscriptions.update.mockImplementationOnce(async (_id: string, params: any) => {
      remoteSubState = { ...remoteSubState, cancel_at_period_end: params.cancel_at_period_end };
      return { ...remoteSubState };
    });

    const cancelPromise = cancelOwnerSubscription(BUSINESS_ID).then((r) => {
      order.push('cancel-resolved');
      return r;
    });

    // Esperar a que `cancelOwnerSubscription` haya tomado el lock y esté
    // efectivamente dentro de la llamada a Stripe (no solo "iniciada").
    await vi.waitFor(() => expect(stripe.subscriptions.update).toHaveBeenCalled());

    const reactivatePromise = reactivateSubscription(BUSINESS_ID).then((r) => {
      order.push('reactivate-resolved');
      return r;
    });

    // Mientras la cancelación sigue "en vuelo" sosteniendo el lock,
    // `reactivateSubscription` todavía no debería haber podido ni empezar
    // su propia reconciliación (bloqueada en `pg_try_advisory_lock`).
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1); // solo la de cancel
    order.push('reactivate-still-blocked-checked');

    gate.resolve();
    const [cancelResult, reactivateResult] = await Promise.all([cancelPromise, reactivatePromise]);

    // Orden real observado: cancel termina por completo ANTES de que
    // reactivate arranque su propia reconciliación.
    expect(order.indexOf('cancel-update-end')).toBeLessThan(
      order.indexOf('reactivate-resolved')
    );
    expect(order).toEqual([
      'cancel-update-start',
      'reactivate-still-blocked-checked',
      'cancel-update-end',
      'cancel-resolved',
      'reactivate-resolved',
    ]);

    // Resultado observable correcto: cancel programó la cancelación;
    // reactivate, al reconciliar DESPUÉS de que cancel ya se aplicó, ve
    // "active_canceling" (no el "active" original) y la deshace realmente
    // — no un no-op basado en estado obsoleto.
    expect(cancelResult.subscription.cancel_at_period_end).toBe(true);
    expect(reactivateResult.subscription.cancel_at_period_end).toBe(false);
    expect(stripe.subscriptions.update).toHaveBeenCalledTimes(2);
    expect(stripe.subscriptions.update).toHaveBeenNthCalledWith(
      2,
      'sub_stripe_1',
      { cancel_at_period_end: false },
      expect.anything()
    );
  });

  it('dos changeSubscriptionPlan concurrentes a planes distintos: el segundo upgrade se aplica sobre el plan que dejó el primero, no sobre el plan inicial', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn(async () => ({ ...remoteSubState })),
        update: vi.fn(),
      },
      subscriptionSchedules: {
        release: vi.fn(),
      },
    };
    mockedGetStripe.mockReturnValue(stripe);

    const order: string[] = [];
    const gate = deferred<void>();

    // basic -> pro queda "en vuelo" (simula la llamada a Stripe tardando).
    stripe.subscriptions.update.mockImplementationOnce(async (_id: string, params: any) => {
      order.push('upgrade-to-pro-start');
      await gate.promise;
      remoteSubState = {
        ...remoteSubState,
        items: { data: [{ id: 'si_1', price: { id: params.items[0].price }, quantity: 1 }] },
      };
      order.push('upgrade-to-pro-end');
      return { ...remoteSubState, latest_invoice: { status: 'paid' } };
    });
    // pro -> business: segunda llamada a `update`, resuelve normal.
    stripe.subscriptions.update.mockImplementationOnce(async (_id: string, params: any) => {
      remoteSubState = {
        ...remoteSubState,
        items: { data: [{ id: 'si_1', price: { id: params.items[0].price }, quantity: 1 }] },
      };
      return { ...remoteSubState, latest_invoice: { status: 'paid' } };
    });

    const firstCall = changeSubscriptionPlan(BUSINESS_ID, 'pro').then((r) => {
      order.push('first-resolved');
      return r;
    });

    await vi.waitFor(() => expect(stripe.subscriptions.update).toHaveBeenCalledTimes(1));

    const secondCall = changeSubscriptionPlan(BUSINESS_ID, 'business').then((r) => {
      order.push('second-resolved');
      return r;
    });

    // Mientras el primer upgrade sigue en vuelo sosteniendo el lock, el
    // segundo todavía no debería haber podido reconciliar ni decidir nada.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1); // solo la del primero
    order.push('second-still-blocked-checked');

    gate.resolve();
    const [firstResult, secondResult] = await Promise.all([firstCall, secondCall]);

    expect(order).toEqual([
      'upgrade-to-pro-start',
      'second-still-blocked-checked',
      'upgrade-to-pro-end',
      'first-resolved',
      'second-resolved',
    ]);

    // El segundo `update` (pro -> business) se hace sobre el ítem YA
    // actualizado a "pro" por el primero, nunca sobre "basic" — si el lock
    // no sirviera, ambas llamadas habrían leído "basic" como plan de
    // partida y el resultado final dependería solo de qué request llegó
    // último a Stripe, no de que el segundo supiera que el primero ya corrió.
    expect(stripe.subscriptions.update).toHaveBeenNthCalledWith(
      2,
      'sub_stripe_1',
      expect.objectContaining({ items: [{ id: 'si_1', price: 'price_business', quantity: 1 }] }),
      expect.anything()
    );
    expect(firstResult.subscription.plan_id).toBe(PLAN_PRO.id);
    expect(secondResult.subscription.plan_id).toBe(PLAN_BUSINESS.id);
  });

  it('webhook de suscripción vs. mutación directa: el webhook con payload "viejo" no revierte lo que la mutación directa ya aplicó', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn(async () => ({ ...remoteSubState })),
        update: vi.fn(),
      },
    };
    mockedGetStripe.mockReturnValue(stripe);

    const order: string[] = [];
    const gate = deferred<void>();

    // `cancelOwnerSubscription` sostiene el lock en vuelo.
    stripe.subscriptions.update.mockImplementationOnce(async (_id: string, params: any) => {
      order.push('cancel-update-start');
      await gate.promise;
      remoteSubState = { ...remoteSubState, cancel_at_period_end: params.cancel_at_period_end };
      order.push('cancel-update-end');
      return { ...remoteSubState };
    });

    const cancelPromise = cancelOwnerSubscription(BUSINESS_ID).then((r) => {
      order.push('cancel-resolved');
      return r;
    });

    await vi.waitFor(() => expect(stripe.subscriptions.update).toHaveBeenCalled());

    // Evento con payload "viejo": trae `cancel_at_period_end: false`, como
    // si fuera anterior a la cancelación — el webhook nunca debe usar este
    // valor directamente, solo como señal de "fijate qué pasó".
    const staleEvent = {
      id: 'evt_stale_1',
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
    } as any;

    const webhookPromise = processStripeWebhookEvent(staleEvent).then(() => {
      order.push('webhook-resolved');
    });

    // Mientras `cancelOwnerSubscription` sigue sosteniendo el lock, el
    // webhook todavía no debería haber podido pedir su propio `retrieve` de
    // reconciliación.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stripe.subscriptions.retrieve).toHaveBeenCalledTimes(1); // solo la de cancel
    order.push('webhook-still-blocked-checked');

    gate.resolve();
    await Promise.all([cancelPromise, webhookPromise]);

    expect(order).toEqual([
      'cancel-update-start',
      'webhook-still-blocked-checked',
      'cancel-update-end',
      'cancel-resolved',
      'webhook-resolved',
    ]);

    // El webhook reconcilió DESPUÉS de la cancelación directa — como nunca
    // usa el payload del evento para los campos mutables, su propio
    // `retrieve` (tomado después de que el lock se liberó) ve
    // `cancel_at_period_end: true`, y eso es lo que persiste. Si el webhook
    // hubiera usado `event.data.object.cancel_at_period_end` (false)
    // directamente, este assert fallaría.
    expect(localSubState.cancel_at_period_end).toBe(true);
  });
});
