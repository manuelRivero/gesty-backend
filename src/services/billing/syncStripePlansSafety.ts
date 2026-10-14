/**
 * Lógica pura (sin I/O) de `scripts/billing/sync-stripe-plans.ts`, separada
 * en su propio módulo para poder testearla con Vitest sin ejecutar `main()`
 * (que se conecta a Prisma y, si todo lo demás pasara, a Stripe).
 *
 * Vive en `src/` (y no en `scripts/`) por convención de tooling: `tsconfig.json`
 * tiene `rootDir: "./src"` e `include: ["src/**\/*"]`, así que cualquier
 * módulo importado por un test de Vitest (que sí vive en `src/`) debe
 * resolver dentro de ese árbol. `scripts/billing/sync-stripe-plans.ts`
 * importa este archivo (igual que ya importa `src/lib/prisma` y
 * `src/constants/planCatalog`), nunca al revés.
 *
 * Ver `scripts/billing/sync-stripe-plans.ts` para el flujo completo y
 * PLAN-ACCION-SHOPPING-ONLY.md para el contexto de la barrera de Test Mode.
 */

import type { plan as PlanRow } from '@prisma/client';

export const STRIPE_TEST_KEY_PREFIX = 'sk_test_';

export class UnsafeStripeModeError extends Error {}
export class PlanSelectionError extends Error {}

/**
 * Valida que la key resuelta sea de Test Mode, sin imprimirla nunca. Lanza
 * antes de que el caller pueda instanciar un cliente Stripe o tocar la base
 * de datos. No usa `NODE_ENV` como señal: ese valor no demuestra nada sobre
 * el modo de la cuenta Stripe.
 */
export function assertTestModeStripeSecretKey(
  key: string | undefined
): string {
  const trimmed = key?.trim();
  if (!trimmed) {
    throw new UnsafeStripeModeError(
      'STRIPE_SECRET_KEY ausente. Abortado antes de cualquier escritura — ' +
        'no se infiere ningún valor por defecto.'
    );
  }
  if (!trimmed.startsWith(STRIPE_TEST_KEY_PREFIX)) {
    // No revelar el valor ni más que "no es de test".
    throw new UnsafeStripeModeError(
      'STRIPE_SECRET_KEY resuelta no es de Test Mode (se esperaba el ' +
        `prefijo "${STRIPE_TEST_KEY_PREFIX}"). Abortado antes de cualquier ` +
        'llamada a Stripe o escritura en la base de datos. ' +
        'NODE_ENV=development no es evidencia de modo Stripe: revisá qué ' +
        'archivo .env* (o variable exportada en el shell) está resolviendo ' +
        'esta key antes de reintentar.'
    );
  }
  return trimmed;
}

/** `--plan <code>` — acota la corrida a un único plan. `null` si no se pidió. */
export function parsePlanFilter(argv: string[]): string | null {
  const idx = argv.indexOf('--plan');
  if (idx === -1) return null;
  const value = argv[idx + 1]?.trim();
  if (!value || value.startsWith('--')) {
    throw new PlanSelectionError(
      '--plan requiere un código de plan como argumento (ej. "--plan shopping_only").'
    );
  }
  return value;
}

export function hasForceFlag(argv: string[]): boolean {
  return argv.includes('--force');
}

/**
 * Selecciona qué filas de `plan` procesar. Nunca incluye `trial` (no es un
 * plan de pago de Checkout). Si se pidió `--plan <code>`, exige que ese
 * código exista entre los planes activos — de lo contrario lanza, en vez de
 * terminar en silencio sin haber sincronizado nada.
 */
export function selectPlansToSync(
  allActivePlans: PlanRow[],
  planFilter: string | null
): PlanRow[] {
  const payable = allActivePlans.filter((p) => p.code !== 'trial');

  if (!planFilter) {
    return payable;
  }

  const match = payable.find((p) => p.code === planFilter);
  if (!match) {
    throw new PlanSelectionError(
      `--plan "${planFilter}" no corresponde a ningún plan activo de pago. ` +
        '¿Falta correr `npm run seed:billing-plans` primero, o el precio ' +
        'en el catálogo sigue sin definir (is_active=false)? Abortado sin ' +
        'tocar Stripe ni la base de datos.'
    );
  }
  return [match];
}

/** Monto en centavos a partir de `monthly_price_usd`; `0` si no hay precio válido. */
export function amountCentsFromPlan(plan: Pick<PlanRow, 'monthly_price_usd'>): number {
  return plan.monthly_price_usd
    ? Math.round(Number(plan.monthly_price_usd) * 100)
    : 0;
}

/**
 * `true` si el plan ya tiene un Price de Stripe y no corresponde recrearlo.
 * Sin `--force`, un plan con `stripe_price_id` se reutiliza y nunca se
 * duplica — ni para `shopping_only` ni para ningún otro plan.
 */
export function shouldReuseExistingPrice(
  plan: Pick<PlanRow, 'stripe_price_id'>,
  force: boolean
): boolean {
  return Boolean(plan.stripe_price_id) && !force;
}

/**
 * Marca de entorno grabada en la metadata de Product/Price de Stripe, junto
 * a `plan_code`. Este sincronizador corre exclusivamente contra Test Mode
 * (`assertTestModeStripeSecretKey`), así que el valor es fijo: no hace falta
 * leerlo de ninguna config para distinguir entornos.
 */
export const STRIPE_SYNC_ENVIRONMENT = 'test';

/** Metadata que identifica de forma estable e inequívoca a qué plan pertenece un Product/Price. */
export function buildPlanStripeMetadata(planCode: string): Record<string, string> {
  return { plan_code: planCode, environment: STRIPE_SYNC_ENVIRONMENT };
}

/** `true` si la metadata de un Product/Price de Stripe corresponde a este plan y entorno. */
export function matchesPlanStripeMetadata(
  candidate: { metadata?: Record<string, string | undefined> | null },
  planCode: string
): boolean {
  return (
    candidate.metadata?.plan_code === planCode &&
    candidate.metadata?.environment === STRIPE_SYNC_ENVIRONMENT
  );
}

/**
 * Decide qué Product reutilizar entre los candidatos encontrados por
 * metadata (cuando no hay `stripe_product_id` persistido todavía). Nunca
 * elige arbitrariamente: 0 candidatos → no hay nada que reutilizar (`null`,
 * el caller crea uno nuevo); 1 candidato → se reutiliza; 2+ → aborta
 * explícito con los IDs, en vez de crear otro producto.
 */
export function selectExistingStripeProduct<T extends { id: string }>(
  candidates: T[],
  planCode: string
): T | null {
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new PlanSelectionError(
      `${planCode}: se encontraron ${candidates.length} productos candidatos en Stripe ` +
        `con metadata.plan_code="${planCode}" (${candidates
          .map((c) => c.id)
          .join(', ')}). Abortado sin crear otro producto — resolver manualmente cuál ` +
        'es el correcto antes de reintentar.'
    );
  }
  return candidates[0];
}

export type ExpectedStripePrice = {
  currency: string;
  unitAmountCents: number;
  interval: string;
};

/** `true` si un Price de Stripe ya existente es compatible (moneda, importe, periodicidad) y está activo. */
export function isCompatibleStripePrice(
  price: {
    currency: string;
    unit_amount: number | null;
    recurring?: { interval?: string | null } | null;
    active?: boolean;
  },
  expected: ExpectedStripePrice
): boolean {
  return (
    price.active !== false &&
    price.currency === expected.currency &&
    price.unit_amount === expected.unitAmountCents &&
    price.recurring?.interval === expected.interval
  );
}

/** Primer Price existente compatible con lo esperado, o `null` si hay que crear uno nuevo. */
export function selectExistingStripePrice<
  T extends Parameters<typeof isCompatibleStripePrice>[0]
>(prices: T[], expected: ExpectedStripePrice): T | null {
  return prices.find((p) => isCompatibleStripePrice(p, expected)) ?? null;
}
