/**
 * Seed catálogo de planes SaaS (`basic`, `pro`, `business`, `shopping_only`).
 * Fuente comercial: https://www.gesty.online/ (precios y ~conv/mes).
 *
 * USO:
 *   npx ts-node scripts/billing/seed-plans.ts
 *
 * `stripe_price_id` no se toca. Si cambió el precio USD, re-sync Stripe:
 *   npm run billing:sync-stripe-plans -- --force
 *
 * `ai_enabled`/`shopping_enabled` se propagan desde `PAID_PLAN_CATALOG` en
 * cada corrida (create y update): un plan sin IA (ej. `shopping_only`,
 * `ai_enabled: false` en el catálogo) nunca vuelve a `true` por una corrida
 * posterior de este script, porque el catálogo es la fuente y no cambia solo.
 *
 * `is_active` solo es `true` si el plan tiene un precio comercial real
 * (`monthly_price_usd`). Un plan sin precio todavía configurado (ej.
 * `shopping_only` antes de que un operador fije su precio real en
 * `planCatalog.ts`) queda `is_active=false`: no aparece como vendible en
 * `/api/public/billing/plans` ni en el checkout, aunque exista en la tabla.
 */

import { prisma } from "../../src/lib/prisma";
import { PAID_PLAN_CATALOG } from "../../src/constants/planCatalog";

async function main() {
  for (const p of PAID_PLAN_CATALOG) {
    const isActive = p.monthly_price_usd != null;
    await prisma.plan.upsert({
      where: { code: p.code },
      create: {
        code: p.code,
        name: p.name,
        monthly_price_usd: p.monthly_price_usd,
        token_limit: p.token_limit,
        description: p.description,
        features: p.features,
        is_active: isActive,
        ai_enabled: p.ai_enabled,
        shopping_enabled: p.shopping_enabled,
      },
      update: {
        name: p.name,
        monthly_price_usd: p.monthly_price_usd,
        token_limit: p.token_limit,
        description: p.description,
        features: p.features,
        is_active: isActive,
        ai_enabled: p.ai_enabled,
        shopping_enabled: p.shopping_enabled,
      },
    });
    console.log(
      `[seed-plans] upserted ${p.code} $${p.monthly_price_usd ?? "(sin precio)"} ` +
        `tokens=${p.token_limit} ~${p.conversations_per_month} conv ` +
        `ai_enabled=${p.ai_enabled} shopping_enabled=${p.shopping_enabled} is_active=${isActive}`
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
