/**
 * Seed catálogo de planes SaaS (`basic`, `pro`, `business`).
 *
 * USO:
 *   npx ts-node -r dotenv/config scripts/billing/seed-plans.ts
 *
 * `stripe_price_id` queda null hasta sync con Stripe (scripts/billing/sync-stripe-plans.ts).
 */

import { prisma } from "../../src/lib/prisma";
import { getDefaultTokenLimitByPlan } from "../../src/services/ai/aiLimits";

const PLANS = [
  {
    code: "basic",
    name: "Basic",
    monthly_price_usd: "29.00",
    token_limit: getDefaultTokenLimitByPlan("basic"),
    description: "Ideal para locales que empiezan con el asistente.",
    features: { seats: 2, support: "email" },
  },
  {
    code: "pro",
    name: "Pro",
    monthly_price_usd: "79.00",
    token_limit: getDefaultTokenLimitByPlan("pro"),
    description: "Más volumen de conversaciones y límites amplios.",
    features: { seats: 5, support: "priority" },
  },
  {
    code: "business",
    name: "Business",
    monthly_price_usd: "199.00",
    token_limit: getDefaultTokenLimitByPlan("enterprise"),
    description: "Alto volumen y operación multi-turno intensiva.",
    features: { seats: 15, support: "dedicated" },
  },
] as const;

async function main() {
  for (const p of PLANS) {
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
    console.log(`[seed-plans] upserted ${p.code}`);
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
