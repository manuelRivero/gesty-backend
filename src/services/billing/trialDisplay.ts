import type { business, subscription } from "@prisma/client";
import { DEFAULT_TRIAL_PLAN_CODE } from "../../constants/billing";
import { prisma } from "../../lib/prisma";

export function isManualTrial(
  sub: Pick<subscription, "is_trial" | "stripe_subscription_id"> | null | undefined
): boolean {
  return Boolean(sub?.is_trial) && !sub?.stripe_subscription_id;
}

/** Plan comercial a exponer: trial manual nunca se muestra como basic/pro. */
export function displayAiPlanCode(
  aiPlan: string | null | undefined,
  sub: Pick<subscription, "is_trial" | "stripe_subscription_id"> | null | undefined
): string {
  if (isManualTrial(sub)) {
    return DEFAULT_TRIAL_PLAN_CODE;
  }
  return (aiPlan ?? "basic").trim().toLowerCase();
}

/** Corrige filas viejas que quedaron con ai_plan=basic durante el trial. */
export async function persistTrialAiPlanIfStale(
  business: business,
  sub: Pick<subscription, "is_trial" | "stripe_subscription_id"> | null | undefined
): Promise<business> {
  if (!isManualTrial(sub) || business.ai_plan === DEFAULT_TRIAL_PLAN_CODE) {
    return business;
  }
  return prisma.business.update({
    where: { id: business.id },
    data: { ai_plan: DEFAULT_TRIAL_PLAN_CODE },
  });
}
