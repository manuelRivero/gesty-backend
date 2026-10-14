/**
 * PLAN-ACCION-SHOPPING-ONLY.md — cobertura de regresión de
 * `stripeCheckout.service.ts` antes de configurar el plan `shopping_only`
 * en Stripe.
 *
 * Además de la regresión original, este archivo cubre la protección contra
 * suscripciones duplicadas (guard de estado + reserva persistida
 * `checkout_attempt` con exclusión a nivel de base de datos).
 *
 * La tabla `checkout_attempt` se simula con un store en memoria dentro del
 * mock de `../../../lib/prisma` que reproduce el comportamiento real que
 * nos importa: `create()` rechaza una segunda fila activa para el mismo
 * `business_id` (igual que el índice único parcial de Postgres), y
 * `updateMany()` solo aplica si la fila sigue en el estado esperado (igual
 * que una transición condicional real). No es una prueba contra Postgres
 * real — ver el test marcado "(equivalente a dos instancias)" y la nota de
 * limitación en la entrega final sobre la prueba de integración pendiente.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import Stripe from 'stripe';

type AttemptRow = {
  id: string;
  business_id: string;
  plan_code: string;
  status: string;
  stripe_checkout_session_id: string | null;
  stripe_customer_id: string | null;
  session_url: string | null;
  session_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

vi.mock('../../../lib/prisma', () => {
  const ACTIVE_STATUSES = new Set(['pending', 'created', 'unresolved']);
  let rows: AttemptRow[] = [];
  let seq = 0;

  const clone = (r: AttemptRow): AttemptRow => ({ ...r });

  const hasActiveConflict = (businessId: string) =>
    rows.some((r) => r.business_id === businessId && ACTIVE_STATUSES.has(r.status));

  const checkout_attempt = {
    findFirst: vi.fn(async ({ where }: any) => {
      const statuses: string[] = where.status.in;
      const matches = rows
        .filter((r) => r.business_id === where.business_id && statuses.includes(r.status))
        .sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return matches[0] ? clone(matches[0]) : null;
    }),
    create: vi.fn(async ({ data }: any) => {
      if (hasActiveConflict(data.business_id)) {
        const err: any = new Error(
          'Unique constraint failed on the fields: (`business_id`)'
        );
        err.code = 'P2002';
        err.meta = { target: ['business_id'] };
        throw err;
      }
      seq += 1;
      const now = new Date();
      const row: AttemptRow = {
        id: `attempt-${seq}`,
        business_id: data.business_id,
        plan_code: data.plan_code,
        status: data.status ?? 'pending',
        stripe_checkout_session_id: null,
        stripe_customer_id: null,
        session_url: null,
        session_expires_at: null,
        created_at: now,
        updated_at: now,
      };
      rows.push(row);
      return clone(row);
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      let count = 0;
      rows = rows.map((r) => {
        if (r.id !== where.id && r.stripe_checkout_session_id !== where.stripe_checkout_session_id) {
          return r;
        }
        if (where.id && r.id !== where.id) return r;
        if (!where.id && where.stripe_checkout_session_id && r.stripe_checkout_session_id !== where.stripe_checkout_session_id) {
          return r;
        }
        if (where.business_id && r.business_id !== where.business_id) return r;
        const allowed: string[] | undefined = where.status?.in;
        if (allowed && !allowed.includes(r.status)) return r;
        count += 1;
        return { ...r, ...data };
      });
      return { count };
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const row = rows.find((r) => r.id === where.id);
      return row ? clone(row) : null;
    }),
  };

  const tx = {
    $executeRaw: vi.fn(async () => undefined),
    checkout_attempt,
  };

  return {
    prisma: {
      subscription: { findUnique: vi.fn() },
      stripe_webhook_event: { findUnique: vi.fn(), create: vi.fn() },
      checkout_attempt,
      $transaction: vi.fn(async (fn: any) => fn(tx)),
      __resetFakeCheckoutAttempts: () => {
        rows = [];
        seq = 0;
      },
      __allFakeCheckoutAttempts: () => rows.map(clone),
    },
  };
});

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
import {
  createCheckoutSession,
  processStripeWebhookEvent,
  reserveOrGetActiveAttempt,
  IDEMPOTENCY_SAFE_WINDOW_MS,
} from '../stripeCheckout.service';

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
const mockedSubscriptionFindUnique = prisma.subscription.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const resetAttempts = (prisma as any).__resetFakeCheckoutAttempts as () => void;
const allAttempts = (prisma as any).__allFakeCheckoutAttempts as () => AttemptRow[];

const BUSINESS_ID = 'biz-1';

const FAR_FUTURE = new Date('2999-01-01T00:00:00.000Z');
const FAR_PAST = new Date('2000-01-01T00:00:00.000Z');

function baseSubscriptionRow(overrides: Partial<Record<string, unknown>> = {}) {
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
    ...overrides,
  };
}

function fakeStripeClient() {
  return {
    checkout: {
      sessions: {
        create: vi.fn().mockResolvedValue({
          id: 'cs_test_1',
          url: 'https://checkout.stripe.com/fake-session',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
        retrieve: vi.fn(),
      },
    },
    subscriptions: {
      retrieve: vi.fn().mockResolvedValue({
        id: 'sub_from_checkout',
        customer: 'cus_1',
        status: 'active',
        cancel_at_period_end: false,
      }),
    },
  };
}

describe('createCheckoutSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAttempts();
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
    mockedSubscriptionFindUnique.mockResolvedValueOnce(null);
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
          checkout_attempt_id: expect.any(String),
        }),
      }),
      expect.objectContaining({ idempotencyKey: expect.any(String) })
    );
  });
});

describe('createCheckoutSession — guard de suscripción existente', () => {
  let stripe: ReturnType<typeof fakeStripeClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAttempts();
    mockedIsConfigured.mockReturnValue(true);
    mockedGetCustomerId.mockResolvedValue('cus_1');
    stripe = fakeStripeClient();
    mockedGetStripe.mockReturnValue(stripe);
    mockedFindPlan.mockResolvedValue({
      id: 'plan-pro',
      code: 'pro',
      stripe_price_id: 'price_pro_test',
    });
  });

  it('sin suscripción existente: permite el checkout y crea un intento `created`', async () => {
    mockedSubscriptionFindUnique.mockResolvedValueOnce(null);

    const result = await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });

    expect(result).toEqual({ url: 'https://checkout.stripe.com/fake-session' });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(allAttempts()).toMatchObject([{ status: 'created', business_id: BUSINESS_ID }]);
  });

  it('suscripción "active": rechaza con 409, no crea Checkout Session ni intento', async () => {
    mockedSubscriptionFindUnique.mockResolvedValueOnce(baseSubscriptionRow({ status: 'active' }));

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 409 });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mockedGetCustomerId).not.toHaveBeenCalled();
    expect(allAttempts()).toEqual([]);
  });

  it('suscripción "trialing": rechaza con 409', async () => {
    mockedSubscriptionFindUnique.mockResolvedValueOnce(
      baseSubscriptionRow({ status: 'trialing', is_trial: true })
    );

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 409 });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(allAttempts()).toEqual([]);
  });

  it('cancelación programada con período vigente: rechaza con 409', async () => {
    mockedSubscriptionFindUnique.mockResolvedValueOnce(
      baseSubscriptionRow({
        status: 'active',
        cancel_at_period_end: true,
        current_period_end: FAR_FUTURE,
      })
    );

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 409 });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('"past_due": no crea una segunda suscripción, devuelve error controlado', async () => {
    mockedSubscriptionFindUnique.mockResolvedValueOnce(
      baseSubscriptionRow({ status: 'past_due' })
    );

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('pago pendiente'),
    });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('suscripción cancelada con período ya terminado: permite checkout nuevo', async () => {
    mockedSubscriptionFindUnique.mockResolvedValueOnce(
      baseSubscriptionRow({
        status: 'canceled',
        cancel_at_period_end: false,
        current_period_end: FAR_PAST,
      })
    );

    const result = await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });

    expect(result).toEqual({ url: 'https://checkout.stripe.com/fake-session' });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
  });

  it('error al consultar la base de datos: no crea Checkout Session ni intento', async () => {
    mockedSubscriptionFindUnique.mockRejectedValueOnce(new Error('DB unreachable'));

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 503 });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(mockedGetCustomerId).not.toHaveBeenCalled();
    expect(allAttempts()).toEqual([]);
  });
});

describe('createCheckoutSession — reserva persistida y mutex en memoria', () => {
  let stripe: ReturnType<typeof fakeStripeClient>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetAttempts();
    mockedIsConfigured.mockReturnValue(true);
    mockedGetCustomerId.mockResolvedValue('cus_1');
    stripe = fakeStripeClient();
    mockedGetStripe.mockReturnValue(stripe);
    mockedFindPlan.mockResolvedValue({
      id: 'plan-pro',
      code: 'pro',
      stripe_price_id: 'price_pro_test',
    });
    mockedSubscriptionFindUnique.mockResolvedValue(null);
  });

  it('dos solicitudes simultáneas para el mismo negocio: solo una crea una Checkout Session', async () => {
    const [a, b] = await Promise.all([
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' }),
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' }).catch((e) => e),
    ]);

    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    // Una de las dos obtiene la URL; la otra, al toparse con el intento
    // `created` recién persistido, la reutiliza (mismo objeto, visto por
    // `sessions.retrieve`) — nunca crea una segunda.
    const urls = [a, b].filter((r) => r && typeof r === 'object' && 'url' in r);
    expect(urls.length).toBeGreaterThanOrEqual(1);
  });

  it('(equivalente a dos instancias) la garantía la da la reserva en la base, no el mutex en memoria', async () => {
    // Llama directo a `reserveOrGetActiveAttempt`, sin pasar por
    // `createCheckoutSession` ni por su mutex en memoria — simula dos
    // procesos independientes compitiendo por el mismo negocio y deja que
    // la exclusión del store (equivalente al índice único parcial de
    // Postgres) sea la única protección en juego.
    const [first, second] = await Promise.all([
      reserveOrGetActiveAttempt(BUSINESS_ID, 'pro'),
      reserveOrGetActiveAttempt(BUSINESS_ID, 'pro'),
    ]);

    const newOnes = [first, second].filter((r) => r.isNew);
    expect(newOnes).toHaveLength(1);
    expect(allAttempts().filter((r) => r.business_id === BUSINESS_ID)).toHaveLength(1);
  });

  it('intento `created` antiguo pero `open` en Stripe: reutiliza la misma URL, no crea otra sesión', async () => {
    await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });
    stripe.checkout.sessions.create.mockClear();

    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
      id: 'cs_test_1',
      status: 'open',
      url: 'https://checkout.stripe.com/fake-session',
    });

    const result = await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });

    expect(result).toEqual({ url: 'https://checkout.stripe.com/fake-session' });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(stripe.checkout.sessions.retrieve).toHaveBeenCalledWith('cs_test_1');
  });

  it('Stripe inaccesible al recuperar un intento `created`: conserva el estado y devuelve 503', async () => {
    await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });
    stripe.checkout.sessions.create.mockClear();

    stripe.checkout.sessions.retrieve.mockRejectedValueOnce(new Error('network down'));

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 503 });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(allAttempts()[0]?.status).toBe('created');
  });

  it('intento `created` cuya sesión ya está `complete`: reconcilia y bloquea con 409', async () => {
    await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });
    stripe.checkout.sessions.create.mockClear();

    const attemptId = allAttempts()[0].id;
    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
      id: 'cs_test_1',
      status: 'complete',
      subscription: 'sub_from_checkout',
      metadata: { business_id: BUSINESS_ID, checkout_attempt_id: attemptId },
    });

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 409 });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(allAttempts()[0]?.status).toBe('completed');
    expect(mockedUpsertSub).toHaveBeenCalledTimes(1);
  });

  it('intento `created` cuya sesión ya expiró: libera el slot y permite un checkout nuevo', async () => {
    await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });
    stripe.checkout.sessions.create.mockClear();

    stripe.checkout.sessions.retrieve.mockResolvedValueOnce({
      id: 'cs_test_1',
      status: 'expired',
      metadata: { business_id: BUSINESS_ID },
    });

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 409 });

    expect(allAttempts()[0]?.status).toBe('expired');

    // Ahora sí, un intento nuevo puede crear una sesión.
    stripe.checkout.sessions.create.mockResolvedValueOnce({
      id: 'cs_test_2',
      url: 'https://checkout.stripe.com/fake-session-2',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });
    expect(result).toEqual({ url: 'https://checkout.stripe.com/fake-session-2' });
  });

  it('`pending` recuperado dentro de la ventana segura: reintenta con la misma idempotencyKey y persiste', async () => {
    // Simula una caída: la reserva quedó en `pending` sin sesión asociada.
    await reserveOrGetActiveAttempt(BUSINESS_ID, 'pro');
    expect(allAttempts()[0].status).toBe('pending');

    const result = await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });

    expect(result).toEqual({ url: 'https://checkout.stripe.com/fake-session' });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(1);
    expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: allAttempts()[0].id })
    );
    expect(allAttempts()[0].status).toBe('created');
  });

  it('reintento después de la ventana segura: no llama a `sessions.create`, pasa a `unresolved` y bloquea', async () => {
    await reserveOrGetActiveAttempt(BUSINESS_ID, 'pro');
    const attempt = allAttempts()[0];
    attempt.created_at = new Date(Date.now() - IDEMPOTENCY_SAFE_WINDOW_MS - 60_000);
    // El store interno vive dentro del mock; mutamos la copia expuesta no
    // alcanza — forzamos la fecha vía updateMany condicional (status sigue
    // siendo `pending`, así que esto es válido para el test).
    await prisma.checkout_attempt.updateMany({
      where: { id: attempt.id, status: { in: ['pending'] } },
      data: { created_at: attempt.created_at },
    });

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('soporte') });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(allAttempts()[0].status).toBe('unresolved');

    // Mientras siga `unresolved`, un intento nuevo también queda bloqueado.
    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 409 });
    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('error determinístico de Stripe al crear: marca `failed` de inmediato y libera el slot', async () => {
    stripe.checkout.sessions.create.mockRejectedValueOnce(
      new Stripe.errors.StripeInvalidRequestError({ message: 'price inválido' } as any)
    );

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 502 });

    expect(allAttempts()[0].status).toBe('failed');

    // `failed` no bloquea permanentemente: un intento nuevo puede proceder.
    stripe.checkout.sessions.create.mockResolvedValueOnce({
      id: 'cs_test_3',
      url: 'https://checkout.stripe.com/fake-session-3',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });
    const result = await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });
    expect(result).toEqual({ url: 'https://checkout.stripe.com/fake-session-3' });
  });

  it('error transitorio de Stripe (conexión) al crear: NO marca `failed`, conserva `pending`', async () => {
    stripe.checkout.sessions.create.mockRejectedValueOnce(
      new Stripe.errors.StripeConnectionError({ message: 'timeout' } as any)
    );

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 503 });

    expect(allAttempts()[0].status).toBe('pending');
  });

  it('colisión de idempotencyKey concurrente (StripeIdempotencyError, 409): NO marca `failed`, permite reintentar con la misma reserva', async () => {
    // Documentado por Stripe (docs.stripe.com/error-low-level#status-codes):
    // 409 "The request conflicts with another request, potentially due to
    // using the same idempotent key" — y la guía explícita es "wait and
    // retry with that key and the same parameters", nunca tratarlo como un
    // fallo definitivo de la operación.
    stripe.checkout.sessions.create.mockRejectedValueOnce(
      new Stripe.errors.StripeIdempotencyError({ message: 'idempotency key in use' } as any)
    );

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 503 });

    // No se creó un intento nuevo ni se marcó `failed` — sigue siendo la
    // MISMA reserva `pending`, lista para que el reintento use la misma
    // idempotencyKey.
    expect(allAttempts()).toHaveLength(1);
    expect(allAttempts()[0].status).toBe('pending');
    const attemptId = allAttempts()[0].id;

    // El reintento (misma reserva, misma clave) ahora sí tiene éxito.
    const result = await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });
    expect(result).toEqual({ url: 'https://checkout.stripe.com/fake-session' });
    expect(stripe.checkout.sessions.create).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ idempotencyKey: attemptId })
    );
  });

  it('P2002 en `create` por una constraint distinta a la del negocio: NO se trata como "ya reservado", se propaga', async () => {
    const createSpy = prisma.checkout_attempt.create as unknown as ReturnType<typeof vi.fn>;
    createSpy.mockImplementationOnce(async () => {
      const err: any = new Error('Unique constraint failed on the fields: (`stripe_checkout_session_id`)');
      err.code = 'P2002';
      err.meta = { target: ['stripe_checkout_session_id'] };
      throw err;
    });

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 503, message: 'No se pudo reservar el intento de checkout' });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    expect(allAttempts()).toHaveLength(0);
  });

  it('P2002 esperado pero sin fila activa encontrada al releer: se propaga en vez de inventar un resultado', async () => {
    const createSpy = prisma.checkout_attempt.create as unknown as ReturnType<typeof vi.fn>;
    const findFirstSpy = prisma.checkout_attempt.findFirst as unknown as ReturnType<typeof vi.fn>;
    createSpy.mockImplementationOnce(async () => {
      const err: any = new Error('Unique constraint failed on the fields: (`business_id`)');
      err.code = 'P2002';
      err.meta = { target: ['business_id'] };
      throw err;
    });
    // La relectura posterior al conflicto no encuentra nada (inconsistencia
    // real — no debería pasar en producción, pero el código no debe
    // inventar una reserva inexistente).
    findFirstSpy.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 503 });

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it('fallo local al persistir después de una respuesta exitosa de Stripe: el intento se recupera sin abrir un segundo checkout', async () => {
    // Primera llamada: Stripe responde con éxito, pero el `updateMany` que
    // persiste el resultado falla (ej. corte de red local hacia la DB justo
    // después de la respuesta de Stripe).
    const updateManySpy = prisma.checkout_attempt.updateMany as unknown as ReturnType<
      typeof vi.fn
    >;
    updateManySpy.mockImplementationOnce(async () => {
      throw new Error('DB unreachable right after Stripe responded');
    });

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toBeTruthy();

    // La fila sigue en `pending` (nunca se persistió el session id), así que
    // el siguiente intento, dentro de la ventana, reintenta con la misma
    // clave y Stripe devuelve el MISMO objeto (idempotencia) sin crear una
    // sesión nueva.
    expect(allAttempts()[0].status).toBe('pending');

    const result = await createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' });
    expect(result).toEqual({ url: 'https://checkout.stripe.com/fake-session' });
    expect(stripe.checkout.sessions.create).toHaveBeenCalledTimes(2);
    expect(stripe.checkout.sessions.create.mock.calls[0][1].idempotencyKey).toEqual(
      stripe.checkout.sessions.create.mock.calls[1][1].idempotencyKey
    );
  });

  it('respuesta tardía: un webhook que completa el intento mientras la fila seguía `pending` no se revierte', async () => {
    const { attempt } = await reserveOrGetActiveAttempt(BUSINESS_ID, 'pro');

    await processStripeWebhookEvent({
      id: 'evt_completed_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_webhook_1',
          metadata: { business_id: BUSINESS_ID, checkout_attempt_id: attempt.id },
          client_reference_id: BUSINESS_ID,
          subscription: null,
        },
      },
    } as any);

    expect(allAttempts()[0].status).toBe('completed');

    // La respuesta "tardía" del create original (si llegara) ya no debería
    // poder pisar `completed` — lo probamos invocando directamente la
    // transición condicional con el estado esperado viejo.
    const result = await prisma.checkout_attempt.updateMany({
      where: { id: attempt.id, status: { in: ['pending'] } },
      data: { status: 'created', stripe_checkout_session_id: 'cs_late' },
    });
    expect(result.count).toBe(0);
    expect(allAttempts()[0].status).toBe('completed');
  });

  it('respuesta tardía real: si un webhook completa el intento ANTES de que persistamos la sesión que Stripe acaba de crear, no se devuelve esa URL', async () => {
    // Simula la carrera real: Stripe ya respondió con la sesión, pero antes
    // de que `attemptStripeSessionCreate` llegue a persistirla, llega (y se
    // procesa) el webhook `checkout.session.completed` para ese mismo
    // intento — por ejemplo porque el usuario pagó usando una sesión que
    // Stripe había creado en un intento anterior recuperado por idempotencia,
    // y el webhook de esa sesión se procesa más rápido que nuestra propia
    // respuesta HTTP.
    stripe.checkout.sessions.create.mockImplementationOnce(async () => {
      const attemptId = allAttempts()[0].id;
      await processStripeWebhookEvent({
        id: 'evt_completed_race',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_1',
            metadata: { business_id: BUSINESS_ID, checkout_attempt_id: attemptId },
            client_reference_id: BUSINESS_ID,
            subscription: null,
          },
        },
      } as any);
      return {
        id: 'cs_test_1',
        url: 'https://checkout.stripe.com/fake-session',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
    });

    await expect(
      createCheckoutSession({ businessId: BUSINESS_ID, planCode: 'pro' })
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('ya se completó') });

    expect(allAttempts()[0].status).toBe('completed');
  });
});

describe('processStripeWebhookEvent — checkout.session.expired', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAttempts();
    mockedWebhookEventCreate.mockResolvedValue({});
  });

  it('expira solo el intento correspondiente a esa sesión, no otro intento posterior del mismo negocio', async () => {
    mockedWebhookEventFindUnique.mockResolvedValue(null);
    const { attempt: oldAttempt } = await reserveOrGetActiveAttempt(BUSINESS_ID, 'pro');
    await prisma.checkout_attempt.updateMany({
      where: { id: oldAttempt.id, status: { in: ['pending'] } },
      data: { status: 'expired', stripe_checkout_session_id: null },
    });
    // Reabrimos el slot manualmente para poder reservar un intento nuevo en
    // este test (en el flujo real, `expired` libera el slot automáticamente).
    await prisma.checkout_attempt.updateMany({
      where: { id: oldAttempt.id, status: { in: ['expired'] } },
      data: { stripe_checkout_session_id: 'cs_old' },
    });

    const { attempt: newAttempt } = await reserveOrGetActiveAttempt(BUSINESS_ID, 'pro');
    await prisma.checkout_attempt.updateMany({
      where: { id: newAttempt.id, status: { in: ['pending'] } },
      data: { status: 'created', stripe_checkout_session_id: 'cs_new' },
    });

    await processStripeWebhookEvent({
      id: 'evt_expired_old',
      type: 'checkout.session.expired',
      data: {
        object: {
          id: 'cs_old',
          metadata: { business_id: BUSINESS_ID, checkout_attempt_id: oldAttempt.id },
        },
      },
    } as any);

    const rows = allAttempts();
    expect(rows.find((r) => r.id === oldAttempt.id)?.status).toBe('expired');
    expect(rows.find((r) => r.id === newAttempt.id)?.status).toBe('created');
  });

  it('webhook duplicado (mismo event.id) sigue siendo idempotente', async () => {
    const { attempt } = await reserveOrGetActiveAttempt(BUSINESS_ID, 'pro');
    await prisma.checkout_attempt.updateMany({
      where: { id: attempt.id, status: { in: ['pending'] } },
      data: { status: 'created', stripe_checkout_session_id: 'cs_dup' },
    });

    mockedWebhookEventFindUnique.mockResolvedValueOnce(null);
    await processStripeWebhookEvent({
      id: 'evt_expired_dup',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_dup', metadata: { checkout_attempt_id: attempt.id } } },
    } as any);
    expect(allAttempts()[0].status).toBe('expired');

    mockedWebhookEventFindUnique.mockResolvedValueOnce({ id: 'row-1', stripe_event_id: 'evt_expired_dup' });
    await processStripeWebhookEvent({
      id: 'evt_expired_dup',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_dup', metadata: { checkout_attempt_id: attempt.id } } },
    } as any);

    expect(allAttempts()[0].status).toBe('expired');
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
    resetAttempts();
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
