import type { business, subscription } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { getEffectiveAiTokenLimit } from "../ai/aiLimits";
import { resetIfNeeded } from "../ai/aiUsage.service";
import { aiPlanToDisplayName } from "../superAdminBusinesses.service";
import { isInactiveSubscriptionStatus } from "../../constants/billing";
import { evaluateSubscriptionRowAccess } from "../billing/evaluateBusinessBillingAccess.service";
import type { BusinessAiQuotaDto } from "../../types/businessAiQuota.dto";
import type { BillingQuotaDto } from "../../types/billing.dto";

export function isActiveSubscription(sub: subscription): boolean {
  const status = sub.status.trim().toLowerCase();
  if (isInactiveSubscriptionStatus(status)) {
    return false;
  }

  if (sub.is_trial && sub.trial_end != null && new Date() > sub.trial_end) {
    return false;
  }

  return true;
}

export function buildQuotaSlice(business: business): BillingQuotaDto {
  const limit = getEffectiveAiTokenLimit(business);
  const used = business.ai_monthly_tokens_used;
  const remaining = Math.max(0, limit - used);

  return {
    tokens_used: used,
    tokens_limit: limit,
    tokens_remaining: remaining,
    ai_blocked: business.ai_blocked,
    has_quota: !business.ai_blocked && used < limit,
    reset_at: business.ai_reset_at.toISOString(),
  };
}

export function buildBusinessAiQuotaDto(
  business: business,
  sub: subscription | null
): BusinessAiQuotaDto {
  const quota = buildQuotaSlice(business);
  const access = evaluateSubscriptionRowAccess(business, sub);

  return {
    ...quota,
    requires_subscription: true,
    access_ok: access.access_ok,
    subscription: sub
      ? {
          status: sub.status,
          is_trial: sub.is_trial ?? false,
          current_period_start: sub.current_period_start.toISOString(),
          current_period_end: sub.current_period_end.toISOString(),
          plan_name: aiPlanToDisplayName(business.ai_plan),
        }
      : null,
  };
}

/**
 * Siempre responde snapshot de cuota si el business existe.
 * Sin sub activa: `access_ok: false`, `subscription: null` (paywall en front).
 */
export async function getBusinessAiQuota(
  businessId: string
): Promise<BusinessAiQuotaDto | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
  });

  if (!business) {
    return null;
  }

  const refreshed = await resetIfNeeded(business);

  const sub = await prisma.subscription.findUnique({
    where: { business_id: businessId },
  });

  return buildBusinessAiQuotaDto(refreshed, sub);
}
