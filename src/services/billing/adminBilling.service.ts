import type { subscription } from "@prisma/client";
import { aiPlanToDisplayName } from "../superAdminBusinesses.service";
import { evaluateSubscriptionRowAccess } from "./evaluateBusinessBillingAccess.service";
import { buildQuotaSlice } from "../subscription/businessAiQuota.service";
import type {
  AdminBillingSubscriptionResponse,
  BillingSubscriptionSnapshotDto,
} from "../../types/billing.dto";
import type { business } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { resetIfNeeded } from "../ai/aiUsage.service";

export function toSubscriptionSnapshot(
  business: business,
  sub: subscription
): BillingSubscriptionSnapshotDto {
  const isTrial = Boolean(sub.is_trial);
  const hasStripeSub = Boolean(sub.stripe_subscription_id);

  // En trial manual (sin sub Stripe) no exponer plan_code de pago:
  // si no, el front marca la card Basic como "plan actual".
  // Los límites siguen en business.ai_plan / ai_monthly_token_limit.
  if (isTrial && !hasStripeSub) {
    return {
      status: sub.status,
      is_trial: true,
      trial_end: sub.trial_end?.toISOString() ?? null,
      current_period_start: sub.current_period_start.toISOString(),
      current_period_end: sub.current_period_end.toISOString(),
      cancel_at_period_end: sub.cancel_at_period_end ?? false,
      plan_code: null,
      plan_name: "Trial",
      stripe_customer_id: sub.stripe_customer_id ?? null,
      has_stripe_subscription: false,
    };
  }

  return {
    status: sub.status,
    is_trial: isTrial,
    trial_end: sub.trial_end?.toISOString() ?? null,
    current_period_start: sub.current_period_start.toISOString(),
    current_period_end: sub.current_period_end.toISOString(),
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    plan_code: business.ai_plan ?? null,
    plan_name: aiPlanToDisplayName(business.ai_plan),
    stripe_customer_id: sub.stripe_customer_id ?? null,
    has_stripe_subscription: hasStripeSub,
  };
}

export async function getAdminBillingSubscription(
  businessId: string
): Promise<AdminBillingSubscriptionResponse | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
  });
  if (!business) return null;

  const refreshed = await resetIfNeeded(business);
  const sub = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });
  const access = evaluateSubscriptionRowAccess(refreshed, sub);

  // Portal solo con suscripción Stripe real. En trial (o sin sub de pago)
  // siempre Checkout para poder convertir a pago antes de que venza.
  const cta: AdminBillingSubscriptionResponse["cta"] =
    access.access_ok &&
    Boolean(sub?.stripe_customer_id) &&
    Boolean(sub?.stripe_subscription_id)
      ? "portal"
      : "checkout";

  return {
    requires_subscription: true,
    access_ok: access.access_ok,
    cta,
    subscription: sub ? toSubscriptionSnapshot(refreshed, sub) : null,
    quota: buildQuotaSlice(refreshed),
  };
}
