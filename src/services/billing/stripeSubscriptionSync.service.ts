import { prisma } from "../../lib/prisma";
import {
  mapStripeStatus,
  periodDatesFromStripeSub,
  priceIdFromStripeSub,
  stripeCustomerId,
  type StripeSubscriptionLike,
} from "./mapStripeSubscription";

export async function syncBusinessAiFromPlan(
  businessId: string,
  opts: { planId?: string | null; planCode?: string | null }
): Promise<void> {
  let plan =
    opts.planId != null
      ? await prisma.plan.findUnique({ where: { id: opts.planId } })
      : null;

  if (!plan && opts.planCode) {
    plan = await prisma.plan.findUnique({ where: { code: opts.planCode } });
  }

  if (!plan) return;

  const aiPlan =
    plan.code === "business" || plan.code === "enterprise"
      ? "enterprise"
      : plan.code === "pro"
        ? "pro"
        : "basic";

  await prisma.business.update({
    where: { id: businessId },
    data: {
      ai_plan: aiPlan,
      ai_monthly_token_limit: plan.token_limit,
      ai_blocked: false,
    },
  });
}

export async function resolvePlanIdFromStripePrice(
  stripePriceId: string | null
): Promise<string | null> {
  if (!stripePriceId) return null;
  const plan = await prisma.plan.findFirst({
    where: { stripe_price_id: stripePriceId },
  });
  return plan?.id ?? null;
}

export async function resolveBusinessIdFromStripeSub(
  stripeSub: StripeSubscriptionLike
): Promise<string | null> {
  const metaBiz = stripeSub.metadata?.business_id?.trim();
  if (metaBiz) return metaBiz;

  const customerId = stripeCustomerId(stripeSub.customer);
  if (customerId) {
    const byCustomer = await prisma.subscription.findFirst({
      where: { stripe_customer_id: customerId },
      select: { business_id: true },
    });
    if (byCustomer) return byCustomer.business_id;
  }

  const bySubId = await prisma.subscription.findFirst({
    where: { stripe_subscription_id: stripeSub.id },
    select: { business_id: true },
  });
  return bySubId?.business_id ?? null;
}

/**
 * Upsert `subscription` desde un objeto Subscription de Stripe y sync AI del business.
 */
export async function upsertSubscriptionFromStripe(
  stripeSub: StripeSubscriptionLike,
  businessId: string
): Promise<void> {
  const customerId = stripeCustomerId(stripeSub.customer);
  const priceId = priceIdFromStripeSub(stripeSub);
  const planId = await resolvePlanIdFromStripePrice(priceId);
  const { start, end } = periodDatesFromStripeSub(stripeSub);
  const status = mapStripeStatus(stripeSub.status);
  const isTrial = status === "trialing";
  const trialEnd =
    stripeSub.trial_end != null ? new Date(stripeSub.trial_end * 1000) : null;

  const existing = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });

  const data = {
    stripe_customer_id: customerId,
    stripe_subscription_id: stripeSub.id,
    stripe_price_id: priceId,
    status,
    cancel_at_period_end: stripeSub.cancel_at_period_end ?? false,
    current_period_start: start,
    current_period_end: end,
    plan_id: planId,
    is_trial: isTrial,
    trial_end: trialEnd,
    updated_at: new Date(),
  };

  if (existing) {
    await prisma.subscription.update({
      where: { business_id: businessId },
      data,
    });
  } else {
    await prisma.subscription.create({
      data: {
        business_id: businessId,
        ...data,
      },
    });
  }

  if (planId) {
    await syncBusinessAiFromPlan(businessId, { planId });
  }
}

export async function markSubscriptionDeletedFromStripe(
  stripeSubscriptionId: string
): Promise<void> {
  const row = await prisma.subscription.findFirst({
    where: { stripe_subscription_id: stripeSubscriptionId },
  });
  if (!row) return;

  await prisma.subscription.update({
    where: { id: row.id },
    data: {
      status: "canceled",
      cancel_at_period_end: false,
      is_trial: false,
      updated_at: new Date(),
    },
  });
}
