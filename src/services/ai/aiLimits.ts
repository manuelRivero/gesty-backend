import type { business } from "@prisma/client";

export function getDefaultTokenLimitByPlan(plan: string): number {
  switch (plan) {
    case "pro":
      return 500000;
    case "enterprise":
      return 2000000;
    case "basic":
    default:
      return 100000;
  }
}

export function getEffectiveAiTokenLimit(b: business): number {
  const plan = b.ai_plan ?? "basic";
  return b.ai_monthly_token_limit ?? getDefaultTokenLimitByPlan(plan);
}
