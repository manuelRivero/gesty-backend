import { prisma } from "../../lib/prisma";
import type { BillingPlanDto } from "../../types/billing.dto";
import { isStripeConfigured } from "./stripe.client";

export async function listActivePlans(opts?: {
  canSubscribe?: boolean;
}): Promise<BillingPlanDto[]> {
  const rows = await prisma.plan.findMany({
    where: { is_active: true },
    orderBy: { monthly_price_usd: "asc" },
  });

  const stripeOk = opts?.canSubscribe ?? isStripeConfigured();

  return rows.map((p) => {
    const hasPrice = Boolean(p.stripe_price_id);
    return {
      code: p.code,
      name: p.name,
      monthly_price_usd:
        p.monthly_price_usd != null ? p.monthly_price_usd.toString() : null,
      token_limit: p.token_limit,
      description: p.description ?? null,
      features: p.features ?? {},
      has_stripe_price: hasPrice,
      can_subscribe: stripeOk && hasPrice,
    };
  });
}

export async function findActivePlanByCode(code: string) {
  return prisma.plan.findFirst({
    where: { code, is_active: true },
  });
}
