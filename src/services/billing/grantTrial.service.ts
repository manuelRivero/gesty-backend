import type { business, subscription } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import {
  DEFAULT_TRIAL_DAYS,
  DEFAULT_TRIAL_PLAN_CODE,
  DEFAULT_TRIAL_TOKEN_LIMIT,
} from "../../constants/billing";

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
 * Cupo por defecto: DEFAULT_TRIAL_TOKEN_LIMIT (no el de Basic).
 */
export async function grantTrialToBusiness(
  input: GrantTrialInput
): Promise<GrantTrialResult> {
  const days = input.days ?? DEFAULT_TRIAL_DAYS;
  const tokenLimit = input.tokenLimit ?? DEFAULT_TRIAL_TOKEN_LIMIT;

  const business = await prisma.business.findUnique({
    where: { id: input.businessId },
  });
  if (!business) {
    throw new Error("Negocio no encontrado");
  }

  const now = new Date();
  const trialEnd = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  const updatedBusiness = await prisma.business.update({
    where: { id: business.id },
    data: {
      ai_plan: DEFAULT_TRIAL_PLAN_CODE,
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
          plan_id: null,
          cancel_at_period_end: false,
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
          plan_id: null,
          cancel_at_period_end: false,
          stripe_customer_id: null,
          stripe_subscription_id: null,
        },
      });

  return { business: updatedBusiness, subscription };
}
