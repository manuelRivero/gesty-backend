/**
 * PLAN-ACCION-SHOPPING-ONLY.md — barreras de seguridad del sincronizador de
 * planes de Stripe (`scripts/billing/sync-stripe-plans.ts`), antes de
 * configurar `shopping_only` (USD 15/mes) en Stripe Test Mode.
 *
 * La lógica probada acá es pura (sin I/O): vive en
 * `scripts/billing/syncStripePlansSafety.ts` precisamente para poder
 * testearla sin conectar a Prisma ni instanciar un cliente Stripe. El
 * script real (`sync-stripe-plans.ts`) no se importa ni se ejecuta desde
 * ningún test — solo se usan sus funciones puras extraídas.
 */

import { describe, expect, it } from 'vitest';
import type { plan } from '@prisma/client';
import {
  amountCentsFromPlan,
  assertTestModeStripeSecretKey,
  hasForceFlag,
  parsePlanFilter,
  PlanSelectionError,
  selectPlansToSync,
  shouldReuseExistingPrice,
  UnsafeStripeModeError,
} from '../syncStripePlansSafety';

function fakePlan(overrides: Partial<plan> = {}): plan {
  return {
    id: 'plan-1',
    name: 'Shopping Only',
    code: 'shopping_only',
    monthly_price_usd: '15.00' as unknown as plan['monthly_price_usd'],
    token_limit: 0,
    is_active: true,
    created_at: new Date('2026-01-01'),
    stripe_product_id: null,
    stripe_price_id: null,
    description: null,
    features: {},
    ai_enabled: false,
    shopping_enabled: true,
    ...overrides,
  } as plan;
}

describe('assertTestModeStripeSecretKey', () => {
  it('aborta (lanza) si la key está ausente, antes de cualquier escritura', () => {
    expect(() => assertTestModeStripeSecretKey(undefined)).toThrow(UnsafeStripeModeError);
    expect(() => assertTestModeStripeSecretKey('')).toThrow(UnsafeStripeModeError);
    expect(() => assertTestModeStripeSecretKey('   ')).toThrow(UnsafeStripeModeError);
  });

  it('aborta (lanza) si la key es sk_live_, sin solo advertir', () => {
    expect(() => assertTestModeStripeSecretKey('sk_live_abc123')).toThrow(UnsafeStripeModeError);
  });

  it('el mensaje de error nunca incluye el valor de la key', () => {
    try {
      assertTestModeStripeSecretKey('sk_live_SECRETO_QUE_NO_DEBE_APARECER');
      throw new Error('no debería llegar acá');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeStripeModeError);
      expect((err as Error).message).not.toContain('SECRETO_QUE_NO_DEBE_APARECER');
    }
  });

  it('acepta y devuelve la key cuando es sk_test_', () => {
    expect(assertTestModeStripeSecretKey('sk_test_abc123')).toBe('sk_test_abc123');
  });

  it('un entorno no verificable (key con formato irreconocible) también aborta', () => {
    expect(() => assertTestModeStripeSecretKey('no-es-una-key-de-stripe')).toThrow(
      UnsafeStripeModeError
    );
  });
});

describe('parsePlanFilter / hasForceFlag', () => {
  it('devuelve null sin --plan', () => {
    expect(parsePlanFilter(['node', 'script.ts'])).toBeNull();
  });

  it('extrae el código pedido con --plan', () => {
    expect(parsePlanFilter(['node', 'script.ts', '--plan', 'shopping_only'])).toBe(
      'shopping_only'
    );
  });

  it('lanza si --plan no trae un código', () => {
    expect(() => parsePlanFilter(['node', 'script.ts', '--plan'])).toThrow(PlanSelectionError);
    expect(() => parsePlanFilter(['node', 'script.ts', '--plan', '--force'])).toThrow(
      PlanSelectionError
    );
  });

  it('detecta --force', () => {
    expect(hasForceFlag(['node', 'script.ts', '--force'])).toBe(true);
    expect(hasForceFlag(['node', 'script.ts'])).toBe(false);
  });
});

describe('selectPlansToSync — acota a un único plan sin tocar los demás', () => {
  const basic = fakePlan({ id: 'plan-basic', code: 'basic', stripe_price_id: 'price_basic' });
  const pro = fakePlan({ id: 'plan-pro', code: 'pro', stripe_price_id: 'price_pro' });
  const business = fakePlan({
    id: 'plan-business',
    code: 'business',
    stripe_price_id: 'price_business',
  });
  const shoppingOnly = fakePlan({ id: 'plan-shopping-only', code: 'shopping_only' });
  const trial = fakePlan({ id: 'plan-trial', code: 'trial', monthly_price_usd: null });

  const allActive = [basic, pro, business, shoppingOnly, trial];

  it('sin --plan, devuelve todos los planes de pago activos (excluye trial)', () => {
    const result = selectPlansToSync(allActive, null);
    expect(result).toEqual([basic, pro, business, shoppingOnly]);
  });

  it('con --plan shopping_only, devuelve EXCLUSIVAMENTE ese plan', () => {
    const result = selectPlansToSync(allActive, 'shopping_only');
    expect(result).toEqual([shoppingOnly]);
    expect(result).not.toContainEqual(basic);
    expect(result).not.toContainEqual(pro);
    expect(result).not.toContainEqual(business);
  });

  it('con --plan de un plan inexistente o inactivo, aborta en vez de terminar en silencio', () => {
    expect(() => selectPlansToSync(allActive, 'shopping_only_v2')).toThrow(PlanSelectionError);
    // Caso real: el precio todavía no está configurado → is_active=false →
    // ni siquiera llega a `allActivePlans` (el caller ya filtró por
    // is_active=true antes de pasarlo). Acá lo simulamos con una lista que
    // no lo incluye en absoluto, para no dejar el plan falsamente habilitado.
    expect(() => selectPlansToSync([basic, pro, business], 'shopping_only')).toThrow(
      PlanSelectionError
    );
  });

  it('con --plan trial, también rechaza (trial no es un plan de pago sincronizable)', () => {
    expect(() => selectPlansToSync(allActive, 'trial')).toThrow(PlanSelectionError);
  });
});

describe('shouldReuseExistingPrice — no duplica Prices existentes', () => {
  it('reutiliza (no recrea) un plan que ya tiene stripe_price_id, sin --force', () => {
    expect(shouldReuseExistingPrice({ stripe_price_id: 'price_existing' }, false)).toBe(true);
  });

  it('crea (no reutiliza) un plan sin stripe_price_id todavía', () => {
    expect(shouldReuseExistingPrice({ stripe_price_id: null }, false)).toBe(false);
  });

  it('con --force, recrea incluso un plan que ya tiene price (comportamiento explícito, no default)', () => {
    expect(shouldReuseExistingPrice({ stripe_price_id: 'price_existing' }, true)).toBe(false);
  });
});

describe('amountCentsFromPlan', () => {
  it('USD 15.00 → 1500 centavos', () => {
    expect(amountCentsFromPlan({ monthly_price_usd: '15.00' as unknown as plan['monthly_price_usd'] })).toBe(
      1500
    );
  });

  it('sin precio → 0 (nunca un valor inventado)', () => {
    expect(amountCentsFromPlan({ monthly_price_usd: null })).toBe(0);
  });
});
