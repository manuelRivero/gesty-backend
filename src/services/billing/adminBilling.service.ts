import type { subscription } from "@prisma/client";
import { aiPlanToDisplayName } from "../superAdminBusinesses.service";
import { evaluateSubscriptionRowAccess } from "./evaluateBusinessBillingAccess.service";
import { buildQuotaSlice } from "../subscription/businessAiQuota.service";
import type {
  AdminBillingSubscriptionResponse,
  BillingActionsDto,
  BillingLifecycleState,
  BillingSubscriptionSnapshotDto,
} from "../../types/billing.dto";
import type { business } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { resetIfNeeded } from "../ai/aiUsage.service";
import {
  classifySubscriptionLifecycle,
  deriveBillingActions,
} from "./subscriptionLifecycle.service";

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
  // `cta` se mantiene por compatibilidad mientras gesty-admin migra a
  // `billing_state`/`actions` — misma condición que siempre tuvo, sin
  // cambios de comportamiento.
  const cta: AdminBillingSubscriptionResponse["cta"] =
    access.access_ok &&
    Boolean(sub?.stripe_customer_id) &&
    Boolean(sub?.stripe_subscription_id)
      ? "portal"
      : "checkout";

  const billingState = classifySubscriptionLifecycle(sub);

  return {
    requires_subscription: true,
    access_ok: access.access_ok,
    cta,
    billing_state: billingState,
    actions: deriveBillingActions(billingState),
    subscription: sub ? toSubscriptionSnapshot(refreshed, sub) : null,
    quota: buildQuotaSlice(refreshed),
  };
}

/**
 * Respuesta compartida por los endpoints de mutación (cancelar/reactivar/
 * cambiar de plan): estado + acciones + snapshot de la suscripción ya
 * actualizada. Reutiliza `toSubscriptionSnapshot`/`classifySubscriptionLifecycle`
 * en vez de reconstruir el DTO en cada controller.
 */
export async function buildSubscriptionActionResult(
  businessId: string,
  sub: subscription
): Promise<{
  billing_state: BillingLifecycleState;
  actions: BillingActionsDto;
  subscription: BillingSubscriptionSnapshotDto;
}> {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) {
    throw Object.assign(new Error("Negocio no encontrado"), { status: 404 });
  }
  const billingState = classifySubscriptionLifecycle(sub);
  return {
    billing_state: billingState,
    actions: deriveBillingActions(billingState),
    subscription: toSubscriptionSnapshot(business, sub),
  };
}
