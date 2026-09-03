/**
 * Crea Products/Prices en Stripe y guarda `stripe_price_id` en `plan`.
 *
 * USO:
 *   npx ts-node -r dotenv/config scripts/billing/sync-stripe-plans.ts
 *   npx ts-node -r dotenv/config scripts/billing/sync-stripe-plans.ts --force
 *
 * --force: recrea Products/Prices aunque ya haya stripe_price_id
 *   (necesario al cambiar de live → test o viceversa).
 *
 * Requiere STRIPE_SECRET_KEY.
 */

import Stripe from "stripe";
import { prisma } from "../../src/lib/prisma";

const force = process.argv.includes("--force");

async function main() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY requerido");
  }

  if (key.startsWith("sk_live_")) {
    console.warn("[sync-stripe-plans] ⚠ usando key LIVE (sk_live_)");
  } else if (key.startsWith("sk_test_")) {
    console.log("[sync-stripe-plans] usando key TEST (sk_test_)");
  }
  if (force) {
    console.log("[sync-stripe-plans] --force: recrear prices");
  }

  const stripe = new Stripe(key);

  const plans = await prisma.plan.findMany({
    where: { is_active: true },
    orderBy: { code: "asc" },
  });

  for (const plan of plans) {
    // "trial" no es un plan de pago del catálogo Checkout
    if (plan.code === "trial") {
      console.log(`[sync-stripe-plans] skip ${plan.code} (no es plan de pago)`);
      continue;
    }

    if (plan.stripe_price_id && !force) {
      console.log(`[sync-stripe-plans] skip ${plan.code} (ya tiene price; usá --force)`);
      continue;
    }

    const amount = plan.monthly_price_usd
      ? Math.round(Number(plan.monthly_price_usd) * 100)
      : 0;
    if (amount <= 0) {
      console.warn(`[sync-stripe-plans] ${plan.code} sin precio USD — skip`);
      continue;
    }

    const product = await stripe.products.create({
      name: `Gesty ${plan.name}`,
      metadata: { plan_code: plan.code },
      description: plan.description ?? undefined,
    });

    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: amount,
      currency: "usd",
      recurring: { interval: "month" },
      metadata: { plan_code: plan.code },
    });

    await prisma.plan.update({
      where: { id: plan.id },
      data: {
        stripe_product_id: product.id,
        stripe_price_id: price.id,
      },
    });

    console.log(
      `[sync-stripe-plans] ${plan.code} → product=${product.id} price=${price.id}`
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
