import type { business, subscription } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { getEffectiveAiTokenLimit } from "../ai/aiLimits";
import { resetIfNeeded } from "../ai/aiUsage.service";
import { aiPlanToDisplayName } from "../superAdminBusinesses.service";
import type { BusinessAiQuotaDto } from "../../types/businessAiQuota.dto";

const INACTIVE_STATUSES = new Set([
  "past_due",
  "unpaid",
  "canceled",
  "cancelled",
  "incomplete_expired",
  "ended"
]);

export function isActiveSubscription(sub: subscription): boolean {
  const status = sub.status.trim().toLowerCase();
  if (INACTIVE_STATUSES.has(status)) {
    return false;
  }

  if (sub.is_trial && sub.trial_end != null && new Date() > sub.trial_end) {
    return false;
  }

  return true;
}

export function buildBusinessAiQuotaDto(
  business: business,
  sub: subscription
): BusinessAiQuotaDto {
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
    subscription: {
      status: sub.status,
      is_trial: sub.is_trial ?? false,
      current_period_start: sub.current_period_start.toISOString(),
      current_period_end: sub.current_period_end.toISOString(),
      plan_name: aiPlanToDisplayName(business.ai_plan)
    }
  };
}

export async function getBusinessAiQuota(
  businessId: string
): Promise<BusinessAiQuotaDto | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId }
  });

  if (!business) {
    return null;
  }

  const refreshed = await resetIfNeeded(business);

  const sub = await prisma.subscription.findUnique({
    where: { business_id: businessId }
  });

  if (!sub || !isActiveSubscription(sub)) {
    return null;
  }

  return buildBusinessAiQuotaDto(refreshed, sub);
}
