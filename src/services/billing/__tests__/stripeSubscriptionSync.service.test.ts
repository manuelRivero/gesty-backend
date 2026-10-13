/**
 * PLAN-ACCION-SHOPPING-ONLY.md — cobertura de regresión de
 * `stripeSubscriptionSync.service.ts` antes de configurar el plan
 * `shopping_only` en Stripe.
 *
 * Cubre el contrato confirmado por la auditoría:
 * - El plan se resuelve exclusivamente por `plan.stripe_price_id`
 *   (`resolvePlanIdFromStripePrice`), nunca por `code` ni por `metadata`.
 * - Un precio sin plan mapeado NO recibe un plan alternativo como fallback
 *   (ni "basic" ni ningún otro): `plan_id` queda `null` y se registra un log
 *   de diagnóstico.
 * - La escritura secundaria de display en `business`
 *   (`syncBusinessAiFromPlan`) nunca concede IA por sí misma: la capacidad
 *   real siempre se deriva de `plan.ai_enabled`/`plan.shopping_enabled` vía
 *   `businessCapabilities.service.ts`, no de `business.ai_plan`/`ai_blocked`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { plan } from '@prisma/client';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    plan: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    subscription: {
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
    business: {
      update: vi.fn(),
    },
  },
}));

import { prisma } from '../../../lib/prisma';
import {
  resolvePlanIdFromStripePrice,
  syncBusinessAiFromPlan,
  upsertSubscriptionFromStripe,
} from '../stripeSubscriptionSync.service';
import { decideAiCapability, decideShoppingCapability } from '../businessCapabilities.service';
import type { StripeSubscriptionLike } from '../mapStripeSubscription';

const mockedPlanFindUnique = prisma.plan.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedPlanFindFirst = prisma.plan.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedSubFindUnique = prisma.subscription.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockedSubUpdate = prisma.subscription.update as unknown as ReturnType<typeof vi.fn>;
const mockedSubCreate = prisma.subscription.create as unknown as ReturnType<typeof vi.fn>;
const mockedBusinessUpdate = prisma.business.update as unknown as ReturnType<typeof vi.fn>;

const BUSINESS_ID = 'biz-1';
const SHOPPING_ONLY_PLAN_ID = 'plan-shopping-only';
const SHOPPING_ONLY_PRICE_ID = 'price_shopping_only_test';

function shoppingOnlyPlan(overrides: Partial<plan> = {}): plan {
  return {
    id: SHOPPING_ONLY_PLAN_ID,
    name: 'Shopping Only',
    code: 'shopping_only',
    monthly_price_usd: null,
    token_limit: 0,
    is_active: true,
    created_at: new Date('2026-01-01'),
    stripe_product_id: 'prod_shopping_only_test',
    stripe_price_id: SHOPPING_ONLY_PRICE_ID,
    description: null,
    features: {},
    ai_enabled: false,
    shopping_enabled: true,
    ...overrides,
  } as plan;
}

function stripeSubLike(overrides: Partial<StripeSubscriptionLike> = {}): StripeSubscriptionLike {
  return {
    id: 'sub_stripe_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    current_period_start: Math.floor(Date.now() / 1000),
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
    trial_end: null,
    items: {
      data: [{ price: { id: SHOPPING_ONLY_PRICE_ID } }],
    },
    metadata: { business_id: BUSINESS_ID },
    ...overrides,
  } as StripeSubscriptionLike;
}

describe('resolvePlanIdFromStripePrice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('devuelve null sin consultar la DB si no hay priceId', async () => {
    const result = await resolvePlanIdFromStripePrice(null);
    expect(result).toBeNull();
    expect(mockedPlanFindFirst).not.toHaveBeenCalled();
  });

  it('resuelve el plan exclusivamente por stripe_price_id (nunca por code)', async () => {
    mockedPlanFindFirst.mockResolvedValueOnce(shoppingOnlyPlan());
    const result = await resolvePlanIdFromStripePrice(SHOPPING_ONLY_PRICE_ID);
    expect(result).toBe(SHOPPING_ONLY_PLAN_ID);
    expect(mockedPlanFindFirst).toHaveBeenCalledWith({
      where: { stripe_price_id: SHOPPING_ONLY_PRICE_ID },
    });
    expect(mockedPlanFindFirst).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ code: expect.anything() }) })
    );
  });

  it('devuelve null si el precio no mapea a ningún plan (sin fallback)', async () => {
    mockedPlanFindFirst.mockResolvedValueOnce(null);
    const result = await resolvePlanIdFromStripePrice('price_unknown');
    expect(result).toBeNull();
  });
});

describe('upsertSubscriptionFromStripe — shopping_only mapeado correctamente', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSubFindUnique.mockResolvedValue(null);
    mockedSubCreate.mockResolvedValue({});
    mockedBusinessUpdate.mockResolvedValue({});
  });

  it('persiste subscription.plan_id = id del plan shopping_only resuelto por price_id', async () => {
    mockedPlanFindFirst.mockResolvedValueOnce(shoppingOnlyPlan());
    mockedPlanFindUnique.mockResolvedValueOnce(shoppingOnlyPlan());

    await upsertSubscriptionFromStripe(stripeSubLike(), BUSINESS_ID);

    expect(mockedSubCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          business_id: BUSINESS_ID,
          plan_id: SHOPPING_ONLY_PLAN_ID,
          stripe_price_id: SHOPPING_ONLY_PRICE_ID,
          status: 'active',
        }),
      })
    );
  });

  it('la escritura secundaria en `business` (display) no concede IA por sí misma', async () => {
    mockedPlanFindFirst.mockResolvedValueOnce(shoppingOnlyPlan());
    mockedPlanFindUnique.mockResolvedValueOnce(shoppingOnlyPlan());

    await upsertSubscriptionFromStripe(stripeSubLike(), BUSINESS_ID);

    // syncBusinessAiFromPlan corrió y escribió en `business`...
    expect(mockedBusinessUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: BUSINESS_ID },
        data: expect.objectContaining({ ai_blocked: false }),
      })
    );

    // ...pero esa escritura NUNCA es la fuente de la capacidad de IA: la
    // capacidad real sigue derivándose del plan persistido, que para
    // shopping_only sigue denegando IA sin importar `ai_blocked: false`.
    const subForCapabilities = {
      status: 'active',
      is_trial: false,
      trial_end: null,
      cancel_at_period_end: false,
      current_period_end: new Date(Date.now() + 86_400_000),
      plan_id: SHOPPING_ONLY_PLAN_ID,
      plan: { ai_enabled: false, shopping_enabled: true },
    };
    expect(decideAiCapability(subForCapabilities, { aiBlocked: false, trialTokensExhausted: false })).toEqual({
      allowed: false,
      reason: 'plan_ai_disabled',
    });
    expect(decideShoppingCapability(subForCapabilities)).toEqual({ allowed: true, reason: 'ok' });
  });
});

describe('upsertSubscriptionFromStripe — precio desconocido', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedSubFindUnique.mockResolvedValue(null);
    mockedSubCreate.mockResolvedValue({});
  });

  it('no asigna ningún plan alternativo y deja plan_id en null', async () => {
    mockedPlanFindFirst.mockResolvedValueOnce(null); // price sin match

    await upsertSubscriptionFromStripe(
      stripeSubLike({ items: { data: [{ price: { id: 'price_unmapped' } }] } }),
      BUSINESS_ID
    );

    expect(mockedSubCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ plan_id: null, stripe_price_id: 'price_unmapped' }),
      })
    );
  });

  it('nunca busca un plan por `code` como fallback (ej. "basic")', async () => {
    mockedPlanFindFirst.mockResolvedValueOnce(null);

    await upsertSubscriptionFromStripe(
      stripeSubLike({ items: { data: [{ price: { id: 'price_unmapped' } }] } }),
      BUSINESS_ID
    );

    expect(mockedPlanFindUnique).not.toHaveBeenCalled();
  });

  it('no ejecuta la escritura secundaria en `business` (sin plan, sin sync de display)', async () => {
    mockedPlanFindFirst.mockResolvedValueOnce(null);

    await upsertSubscriptionFromStripe(
      stripeSubLike({ items: { data: [{ price: { id: 'price_unmapped' } }] } }),
      BUSINESS_ID
    );

    expect(mockedBusinessUpdate).not.toHaveBeenCalled();
  });

  it('registra un log de diagnóstico de precio sin mapear', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockedPlanFindFirst.mockResolvedValueOnce(null);

    await upsertSubscriptionFromStripe(
      stripeSubLike({ items: { data: [{ price: { id: 'price_unmapped' } }] } }),
      BUSINESS_ID
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('price_unmapped_to_plan')
    );
    warnSpy.mockRestore();
  });
});

describe('syncBusinessAiFromPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no escribe nada en `business` si el plan no se resuelve (sin planId ni planCode válidos)', async () => {
    mockedPlanFindUnique.mockResolvedValueOnce(null);
    await syncBusinessAiFromPlan(BUSINESS_ID, { planId: 'ghost-plan' });
    expect(mockedBusinessUpdate).not.toHaveBeenCalled();
  });

  it('para shopping_only, el display `ai_plan` no es "basic" ni "enterprise" (no es fuente de autorización, pero tampoco debe sugerir IA por error)', async () => {
    mockedPlanFindUnique.mockResolvedValueOnce(shoppingOnlyPlan());
    await syncBusinessAiFromPlan(BUSINESS_ID, { planId: SHOPPING_ONLY_PLAN_ID });
    expect(mockedBusinessUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ai_plan: 'shopping_only' }),
      })
    );
  });
});
