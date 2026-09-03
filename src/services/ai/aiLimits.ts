import type { business } from "@prisma/client";
import { DEFAULT_TRIAL_TOKEN_LIMIT } from "../../constants/billing";
import { getPaidPlanByCode } from "../../constants/planCatalog";

export function getDefaultTokenLimitByPlan(plan: string): number {
  if (plan === "trial") {
    return DEFAULT_TRIAL_TOKEN_LIMIT;
  }
  const paid = getPaidPlanByCode(plan);
  if (paid) {
    return paid.token_limit;
  }
  return getPaidPlanByCode("basic")!.token_limit;
}

export function getEffectiveAiTokenLimit(b: business): number {
  const plan = b.ai_plan ?? "basic";
  return b.ai_monthly_token_limit ?? getDefaultTokenLimitByPlan(plan);
}
