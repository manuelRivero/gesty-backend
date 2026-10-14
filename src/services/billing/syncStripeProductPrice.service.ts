/**
 * Orquestación con I/O (Stripe + Prisma) de `scripts/billing/sync-stripe-plans.ts`.
 * Separada de `syncStripePlansSafety.ts` (lógica pura) para poder testear
 * esta parte con mocks de Stripe y de persistencia, sin llamadas reales.
 *
 * Reglas (ver PLAN-ACCION-SHOPPING-ONLY.md y la auditoría de duplicados):
 * - Si el plan ya tiene `stripe_product_id`, se recupera y reutiliza ese
 *   Product — nunca se busca ni se crea otro.
 * - Si no hay ID persistido, se busca por metadata (`plan_code` +
 *   `environment`, nunca por nombre) entre los Products existentes. 0
 *   candidatos → se crea uno nuevo con esa metadata. 1 → se reutiliza. 2+ →
 *   aborta explícito (`PlanSelectionError`), sin crear ni elegir al azar.
 * - El Price se resuelve igual: se reutiliza un Price activo compatible
 *   (moneda + importe + periodicidad) del Product resuelto; si no hay
 *   ninguno compatible, se crea uno nuevo y el anterior queda intacto (no
 *   se desactiva).
 * - Los IDs de Stripe se persisten en `plan` solo después de validar/crear
 *   ambos objetos.
 */

import { prisma } from '../../lib/prisma';
import {
  buildPlanStripeMetadata,
  isCompatibleStripePrice,
  selectExistingStripePrice,
  selectExistingStripeProduct,
  matchesPlanStripeMetadata,
  PlanSelectionError,
  type ExpectedStripePrice,
} from './syncStripePlansSafety';

export type StripeProductLike = {
  id: string;
  deleted?: boolean | void;
  metadata?: Record<string, string | undefined> | null;
};

export type StripePriceLike = Parameters<typeof isCompatibleStripePrice>[0] & { id: string };

export interface StripeProductsClientLike {
  retrieve(id: string): Promise<StripeProductLike>;
  create(params: {
    name: string;
    description?: string;
    metadata: Record<string, string>;
  }): Promise<StripeProductLike>;
  list(params: { limit: number }): Promise<{ data: StripeProductLike[] }>;
}

export interface StripePricesClientLike {
  list(params: {
    product: string;
    active: boolean;
    limit: number;
  }): Promise<{ data: StripePriceLike[] }>;
  create(params: {
    product: string;
    unit_amount: number;
    currency: string;
    recurring: { interval: string };
    metadata: Record<string, string>;
  }): Promise<StripePriceLike>;
}

export interface StripeClientLike {
  products: StripeProductsClientLike;
  prices: StripePricesClientLike;
}

export type PlanForStripeSync = {
  id: string;
  code: string;
  name: string;
  description?: string | null;
  stripe_product_id: string | null;
};

async function resolveStripeProduct(
  stripe: StripeClientLike,
  plan: PlanForStripeSync
): Promise<StripeProductLike> {
  if (plan.stripe_product_id) {
    const existing = await stripe.products.retrieve(plan.stripe_product_id);
    if (existing.deleted) {
      throw new PlanSelectionError(
        `${plan.code}: stripe_product_id "${plan.stripe_product_id}" está borrado en Stripe. ` +
          'Abortado — resolver manualmente (limpiar el ID persistido o restaurar el producto) antes de reintentar.'
      );
    }
    return existing;
  }

  const existingProducts = await stripe.products.list({ limit: 100 });
  const candidates = existingProducts.data.filter((p) =>
    matchesPlanStripeMetadata(p, plan.code)
  );
  const match = selectExistingStripeProduct(candidates, plan.code);
  if (match) return match;

  return stripe.products.create({
    name: `Gesty ${plan.name}`,
    description: plan.description ?? undefined,
    metadata: buildPlanStripeMetadata(plan.code),
  });
}

async function resolveStripePrice(
  stripe: StripeClientLike,
  product: StripeProductLike,
  planCode: string,
  expected: ExpectedStripePrice
): Promise<StripePriceLike> {
  const existingPrices = await stripe.prices.list({
    product: product.id,
    active: true,
    limit: 100,
  });
  const match = selectExistingStripePrice(existingPrices.data, expected);
  if (match) return match;

  return stripe.prices.create({
    product: product.id,
    unit_amount: expected.unitAmountCents,
    currency: expected.currency,
    recurring: { interval: expected.interval },
    metadata: buildPlanStripeMetadata(planCode),
  });
}

/**
 * Resuelve (reutilizando lo que ya exista) el Product y Price de Stripe de
 * un plan y persiste sus IDs. Si una corrida anterior creó los objetos en
 * Stripe pero falló al persistir, la metadata grabada en Stripe permite que
 * el siguiente intento los encuentre y reutilice en vez de duplicarlos.
 */
export async function resolveAndPersistStripeProductAndPrice(
  stripe: StripeClientLike,
  plan: PlanForStripeSync,
  expected: ExpectedStripePrice
): Promise<{ product: StripeProductLike; price: StripePriceLike }> {
  const product = await resolveStripeProduct(stripe, plan);
  const price = await resolveStripePrice(stripe, product, plan.code, expected);

  await prisma.plan.update({
    where: { id: plan.id },
    data: {
      stripe_product_id: product.id,
      stripe_price_id: price.id,
    },
  });

  return { product, price };
}
