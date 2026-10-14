/**
 * Crea Products/Prices en Stripe y guarda `stripe_price_id` en `plan`.
 *
 * USO:
 *   NODE_ENV=development npx ts-node scripts/billing/sync-stripe-plans.ts
 *   NODE_ENV=development npx ts-node scripts/billing/sync-stripe-plans.ts --plan shopping_only
 *   NODE_ENV=development npx ts-node scripts/billing/sync-stripe-plans.ts --force
 *
 * --plan <code>: acota la sincronización a un único plan (ej. `shopping_only`).
 *   Los demás planes activos no se tocan — ni se crean, ni se actualizan, ni
 *   se recrean sus Products/Prices. Si el plan pedido no existe, no está
 *   activo o no tiene un precio válido, el script aborta (exit 1) con un
 *   mensaje claro en vez de terminar en silencio sin haber hecho nada.
 *
 * --force: recrea Products/Prices aunque ya haya stripe_price_id
 *   (necesario al cambiar de live → test o viceversa). Sin `--plan`, afecta
 *   a TODOS los planes activos — no usar para una alta acotada de un solo
 *   plan nuevo.
 *
 * Barrera de seguridad (PLAN-ACCION-SHOPPING-ONLY.md): este script SOLO
 * corre contra Stripe Test Mode. Si `STRIPE_SECRET_KEY` no está presente o
 * no tiene el prefijo `sk_test_`, aborta ANTES de cualquier llamada a Stripe
 * o escritura en la base de datos — no imprime la key, solo su ausencia o
 * su modo. No basta con `NODE_ENV=development`: ese valor no demuestra nada
 * sobre el modo de la cuenta Stripe, así que no se usa como señal de
 * seguridad. Esta barrera hace que, hoy, el script no pueda usarse para un
 * alta en Stripe Live — eso requiere una decisión y un cambio explícitos
 * aparte, fuera de este script. La lógica de validación vive, sin I/O, en
 * `src/services/billing/syncStripePlansSafety.ts` (testeada en
 * `src/services/billing/__tests__/`).
 */

import Stripe from "stripe";
import { prisma } from "../../src/lib/prisma";
import type { plan as PlanRow } from "@prisma/client";
import {
  amountCentsFromPlan,
  assertTestModeStripeSecretKey,
  buildPlanStripeMetadata,
  hasForceFlag,
  parsePlanFilter,
  PlanSelectionError,
  selectPlansToSync,
  shouldReuseExistingPrice,
  UnsafeStripeModeError,
} from "../../src/services/billing/syncStripePlansSafety";
import { resolveAndPersistStripeProductAndPrice } from "../../src/services/billing/syncStripeProductPrice.service";

async function syncOnePlan(
  stripe: Stripe,
  plan: PlanRow,
  force: boolean
): Promise<void> {
  if (shouldReuseExistingPrice(plan, force)) {
    console.log(
      `[sync-stripe-plans] skip ${plan.code} (ya tiene stripe_price_id; reutilizado, no se duplica)`
    );
    return;
  }

  const amount = amountCentsFromPlan(plan);
  if (amount <= 0) {
    throw new PlanSelectionError(
      `${plan.code} no tiene un precio USD válido (monthly_price_usd). ` +
        "Abortado: no se crea un Product/Price sin precio real."
    );
  }

  if (force) {
    // --force es un reemplazo explícito pedido por el operador (ej. cambiar
    // de live a test): a propósito NO busca duplicados, siempre crea de
    // cero. Fuera de --force, `resolveAndPersistStripeProductAndPrice`
    // abajo es el único camino, y ese sí reutiliza por ID/metadata.
    const product = await stripe.products.create({
      name: `Gesty ${plan.name}`,
      metadata: buildPlanStripeMetadata(plan.code),
      description: plan.description ?? undefined,
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: amount,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: buildPlanStripeMetadata(plan.code),
    });

    await prisma.plan.update({
      where: { id: plan.id },
      data: {
        stripe_product_id: product.id,
        stripe_price_id: price.id,
      },
    });

    console.log(
      `[sync-stripe-plans] ${plan.code} → product=${product.id} price=${price.id} (--force)`
    );
    return;
  }

  const { product, price } = await resolveAndPersistStripeProductAndPrice(
    stripe,
    plan,
    { currency: "usd", unitAmountCents: amount, interval: "month" }
  );

  console.log(
    `[sync-stripe-plans] ${plan.code} → product=${product.id} price=${price.id}`
  );
}

async function main() {
  const planFilter = parsePlanFilter(process.argv);
  const force = hasForceFlag(process.argv);

  if (force && planFilter) {
    console.log(
      `[sync-stripe-plans] --force + --plan ${planFilter}: solo recrea ese plan, los demás no se tocan`
    );
  } else if (force) {
    console.log(
      "[sync-stripe-plans] --force sin --plan: recrea Products/Prices de TODOS los planes activos"
    );
  }

  // Barrera de seguridad: aborta ANTES de instanciar el cliente Stripe o
  // tocar la base de datos si la key no es verificablemente de Test Mode.
  const key = assertTestModeStripeSecretKey(process.env.STRIPE_SECRET_KEY);
  console.log("[sync-stripe-plans] STRIPE_SECRET_KEY verificada: Test Mode (sk_test_)");

  const stripe = new Stripe(key);

  const activePlans = await prisma.plan.findMany({
    where: { is_active: true },
    orderBy: { code: "asc" },
  });

  const plansToSync = selectPlansToSync(activePlans, planFilter);

  if (plansToSync.length === 0) {
    console.log("[sync-stripe-plans] sin planes activos de pago para sincronizar");
    return;
  }

  for (const plan of plansToSync) {
    await syncOnePlan(stripe, plan, force);
  }
}

main()
  .catch((err) => {
    console.error(
      err instanceof UnsafeStripeModeError || err instanceof PlanSelectionError
        ? `[sync-stripe-plans] ABORTADO: ${err.message}`
        : err
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
