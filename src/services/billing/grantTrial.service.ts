import type { business, subscription } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  DEFAULT_TRIAL_DAYS,
  DEFAULT_TRIAL_PLAN_CODE,
} from "../../constants/billing";
import { getDefaultTokenLimitByPlan } from "../ai/aiLimits";
import { findActivePlanByCode } from "./planCatalog.service";

export type GrantTrialInput = {
  businessId: string;
  days?: number;
  planCode?: string;
  tokenLimit?: number;
};

export type GrantTrialResult = {
  business: business;
  subscription: subscription;
};

/**
 * Crea o actualiza una subscription en trial sin Stripe.
 * Usado en onboarding y soporte super-admin.
 */
export async function grantTrialToBusiness(
  input: GrantTrialInput
): Promise<GrantTrialResult> {
  const days = input.days ?? DEFAULT_TRIAL_DAYS;
  const planCode = (input.planCode ?? DEFAULT_TRIAL_PLAN_CODE).trim().toLowerCase();

  const business = await prisma.business.findUnique({
    where: { id: input.businessId },
  });
  if (!business) {
    throw new Error("Negocio no encontrado");
  }

  const plan =
    (await findActivePlanByCode(planCode)) ??
    (await findActivePlanByCode(DEFAULT_TRIAL_PLAN_CODE));

  const tokenLimit =
    input.tokenLimit ??
    plan?.token_limit ??
    getDefaultTokenLimitByPlan(planCode === "business" ? "enterprise" : planCode);

  const now = new Date();
  const trialEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const aiPlanCode =
    planCode === "business" || planCode === "enterprise"
      ? "enterprise"
      : planCode === "pro"
        ? "pro"
        : "basic";

  const updatedBusiness = await prisma.business.update({
    where: { id: business.id },
    data: {
      ai_plan: aiPlanCode,
      ai_monthly_token_limit: tokenLimit,
      ai_blocked: false,
      billing_mode: "subscription",
    },
  });

  const existing = await prisma.subscription.findUnique({
    where: { business_id: business.id },
  });

  const subscription = existing
    ? await prisma.subscription.update({
        where: { business_id: business.id },
        data: {
          status: "trialing",
          is_trial: true,
          trial_end: trialEnd,
          current_period_start: now,
          current_period_end: trialEnd,
          plan_id: plan?.id ?? null,
          cancel_at_period_end: false,
          // Limpia IDs inventados / de otro entorno (ej. cus_manual_*)
          stripe_customer_id: null,
          stripe_subscription_id: null,
          stripe_price_id: null,
          updated_at: now,
        },
      })
    : await prisma.subscription.create({
        data: {
          business_id: business.id,
          status: "trialing",
          is_trial: true,
          trial_end: trialEnd,
          current_period_start: now,
          current_period_end: trialEnd,
          plan_id: plan?.id ?? null,
          cancel_at_period_end: false,
          stripe_customer_id: null,
          stripe_subscription_id: null,
        },
      });

  return { business: updatedBusiness, subscription };
}
