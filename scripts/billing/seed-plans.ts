/**
 * Seed catálogo de planes SaaS (`basic`, `pro`, `business`).
 * Fuente comercial: https://www.gesty.online/ (precios y ~conv/mes).
 *
 * USO:
 *   npx ts-node scripts/billing/seed-plans.ts
 *
 * `stripe_price_id` no se toca. Si cambió el precio USD, re-sync Stripe:
 *   npm run billing:sync-stripe-plans -- --force
 */

import { prisma } from "../../src/lib/prisma";
import { PAID_PLAN_CATALOG } from "../../src/constants/planCatalog";

async function main() {
  for (const p of PAID_PLAN_CATALOG) {
    await prisma.plan.upsert({
      where: { code: p.code },
      create: {
        code: p.code,
        name: p.name,
        monthly_price_usd: p.monthly_price_usd,
        token_limit: p.token_limit,
        description: p.description,
        features: p.features,
        is_active: true,
      },
      update: {
        name: p.name,
        monthly_price_usd: p.monthly_price_usd,
        token_limit: p.token_limit,
        description: p.description,
        features: p.features,
        is_active: true,
      },
    });
    console.log(
      `[seed-plans] upserted ${p.code} $${p.monthly_price_usd} tokens=${p.token_limit} ~${p.conversations_per_month} conv`
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
