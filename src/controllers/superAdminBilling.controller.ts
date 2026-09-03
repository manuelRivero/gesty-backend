import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { getBusinessAiQuota } from "../services/subscription/businessAiQuota.service";
import { toSubscriptionSnapshot } from "../services/billing/adminBilling.service";
import { evaluateSubscriptionRowAccess } from "../services/billing/evaluateBusinessBillingAccess.service";
import { grantTrialToBusiness } from "../services/billing/grantTrial.service";
import {
  displayAiPlanCode,
  persistTrialAiPlanIfStale,
} from "../services/billing/trialDisplay";
import {
  cancelSubscriptionAtPeriodEnd,
  syncSubscriptionFromStripeApi,
} from "../services/billing/stripeCheckout.service";
import type { SuperAdminBillingDetailDto } from "../types/billing.dto";
import {
  DEFAULT_TRIAL_DAYS,
  DEFAULT_TRIAL_PLAN_CODE,
  DEFAULT_TRIAL_TOKEN_LIMIT,
} from "../constants/billing";

const idParamSchema = z.object({
  id: z.string().uuid(),
});

function httpErrorStatus(err: unknown): number | null {
  if (
    err &&
    typeof err === "object" &&
    "status" in err &&
    typeof (err as { status: unknown }).status === "number"
  ) {
    return (err as { status: number }).status;
  }
  return null;
}

async function loadBillingDetail(
  businessId: string
): Promise<SuperAdminBillingDetailDto | null> {
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    include: { subscription: true },
  });
  if (!business) return null;

  const healed = await persistTrialAiPlanIfStale(
    business,
    business.subscription
  );
  const sub = business.subscription;
  const access = evaluateSubscriptionRowAccess(healed, sub);
  const quota = await getBusinessAiQuota(businessId);
  if (!quota) return null;

  return {
    business_id: healed.id,
    business_name: healed.name,
    access_ok: access.access_ok,
    has_subscription_row: Boolean(sub),
    ai_plan: displayAiPlanCode(healed.ai_plan, sub),
    ai_monthly_token_limit: healed.ai_monthly_token_limit,
    ai_monthly_tokens_used: healed.ai_monthly_tokens_used,
    ai_blocked: healed.ai_blocked,
    subscription: sub ? toSubscriptionSnapshot(healed, sub) : null,
    quota: {
      tokens_used: quota.tokens_used,
      tokens_limit: quota.tokens_limit,
      tokens_remaining: quota.tokens_remaining,
      ai_blocked: quota.ai_blocked,
      has_quota: quota.has_quota,
      reset_at: quota.reset_at,
    },
  };
}

export async function getSuperAdminTrialDefaults(
  _req: Request,
  res: Response
): Promise<void> {
  res.json({
    days: DEFAULT_TRIAL_DAYS,
    token_limit: DEFAULT_TRIAL_TOKEN_LIMIT,
    plan_code: DEFAULT_TRIAL_PLAN_CODE,
    max_days: 90,
  });
}

export async function getSuperAdminBusinessBilling(
  req: Request,
  res: Response
): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "id inválido" });
    return;
  }

  const detail = await loadBillingDetail(parsed.data.id);
  if (!detail) {
    res.status(404).json({ error: "Negocio no encontrado" });
    return;
  }
  res.json(detail);
}

const patchBodySchema = z
  .object({
    ai_plan: z.string().min(1).optional(),
    ai_monthly_token_limit: z.number().int().positive().optional(),
    ai_blocked: z.boolean().optional(),
  })
  .refine(
    (b) =>
      b.ai_plan !== undefined ||
      b.ai_monthly_token_limit !== undefined ||
      b.ai_blocked !== undefined,
    { message: "Sin campos para actualizar" }
  );

export async function patchSuperAdminBusinessBilling(
  req: Request,
  res: Response
): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "id inválido" });
    return;
  }

  const body = patchBodySchema.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: "Body inválido",
      details: body.error.flatten(),
    });
    return;
  }

  const existing = await prisma.business.findUnique({
    where: { id: parsed.data.id },
  });
  if (!existing) {
    res.status(404).json({ error: "Negocio no encontrado" });
    return;
  }

  await prisma.business.update({
    where: { id: parsed.data.id },
    data: {
      ...(body.data.ai_plan !== undefined
        ? { ai_plan: body.data.ai_plan.trim().toLowerCase() }
        : {}),
      ...(body.data.ai_monthly_token_limit !== undefined
        ? { ai_monthly_token_limit: body.data.ai_monthly_token_limit }
        : {}),
      ...(body.data.ai_blocked !== undefined
        ? { ai_blocked: body.data.ai_blocked }
        : {}),
    },
  });

  const detail = await loadBillingDetail(parsed.data.id);
  res.json(detail);
}

const grantTrialBodySchema = z.object({
  days: z.number().int().positive().max(90).optional(),
  plan_code: z.string().min(1).optional(),
  token_limit: z.number().int().positive().optional(),
});

export async function postSuperAdminGrantTrial(
  req: Request,
  res: Response
): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "id inválido" });
    return;
  }

  const body = grantTrialBodySchema.safeParse(req.body ?? {});
  if (!body.success) {
    res.status(400).json({
      error: "Body inválido",
      details: body.error.flatten(),
    });
    return;
  }

  try {
    await grantTrialToBusiness({
      businessId: parsed.data.id,
      days: body.data.days ?? DEFAULT_TRIAL_DAYS,
      tokenLimit: body.data.token_limit,
    });
    const detail = await loadBillingDetail(parsed.data.id);
    res.json(detail);
  } catch (err) {
    res.status(404).json({
      error: err instanceof Error ? err.message : "Error otorgando trial",
    });
  }
}

export async function postSuperAdminSyncStripe(
  req: Request,
  res: Response
): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "id inválido" });
    return;
  }

  try {
    await syncSubscriptionFromStripeApi(parsed.data.id);
    const detail = await loadBillingDetail(parsed.data.id);
    res.json(detail);
  } catch (err) {
    const status = httpErrorStatus(err) ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Error sync Stripe",
    });
  }
}

export async function postSuperAdminCancelBilling(
  req: Request,
  res: Response
): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "id inválido" });
    return;
  }

  try {
    await cancelSubscriptionAtPeriodEnd(parsed.data.id);
    const detail = await loadBillingDetail(parsed.data.id);
    res.json(detail);
  } catch (err) {
    const status = httpErrorStatus(err) ?? 500;
    res.status(status).json({
      error: err instanceof Error ? err.message : "Error cancelando",
    });
  }
}
