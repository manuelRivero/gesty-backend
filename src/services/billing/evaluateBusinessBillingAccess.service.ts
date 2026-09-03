import type { business, subscription } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { resetIfNeeded } from "../ai/aiUsage.service";
import { getEffectiveAiTokenLimit } from "../ai/aiLimits";
import { isInactiveSubscriptionStatus } from "../../constants/billing";
import { formatBotUserMessage } from "../productQuery/utils";

export const BILLING_ACCESS_MESSAGES = {
  noSubscription: formatBotUserMessage(
    "Plan requerido",
    "💳",
    "Este local no tiene un plan activo. Suscribite desde el panel de administración."
  ),
  trialDateEnded: formatBotUserMessage(
    "Período de prueba",
    "⏳",
    "Tu período de prueba finalizó. Contratá un plan para seguir usando el asistente automático."
  ),
  trialTokensExhausted: formatBotUserMessage(
    "Tokens agotados",
    "⚡",
    "Se agotaron los tokens de tu período de prueba. Actualizá tu plan para continuar."
  ),
  inactive: formatBotUserMessage(
    "Suscripción inactiva",
    "💳",
    "Tu suscripción no está activa. Actualizá el pago desde el panel."
  ),
} as const;

export type BillingAccessOk = { ok: true; business: business };
export type BillingAccessBlocked = { ok: false; message: string };
export type BillingAccessResult = BillingAccessOk | BillingAccessBlocked;

function subscriptionGrantsAccess(
  business: business,
  sub: subscription
):
  | { ok: true }
  | { ok: false; reason: "trial_ended" | "trial_tokens" | "inactive" } {
  if (sub.is_trial && sub.trial_end != null && new Date() > sub.trial_end) {
    return { ok: false, reason: "trial_ended" };
  }
  if (sub.is_trial) {
    const limit = getEffectiveAiTokenLimit(business);
    if (business.ai_monthly_tokens_used >= limit) {
      return { ok: false, reason: "trial_tokens" };
    }
  }
  if (isInactiveSubscriptionStatus(sub.status)) {
    return { ok: false, reason: "inactive" };
  }
  return { ok: true };
}

/**
 * Evaluador único de acceso por suscripción obligatoria (Opción B).
 * `ai_blocked` se maneja en openai / STT (cupo mensual), no acá.
 */
export async function evaluateBusinessBillingAccess(
  business: business
): Promise<BillingAccessResult> {
  const refreshed = await resetIfNeeded(business);

  const sub = await prisma.subscription.findUnique({
    where: { business_id: refreshed.id },
  });

  if (!sub) {
    return { ok: false, message: BILLING_ACCESS_MESSAGES.noSubscription };
  }

  const access = subscriptionGrantsAccess(refreshed, sub);
  if (!access.ok) {
    if (access.reason === "trial_ended") {
      return { ok: false, message: BILLING_ACCESS_MESSAGES.trialDateEnded };
    }
    if (access.reason === "trial_tokens") {
      return { ok: false, message: BILLING_ACCESS_MESSAGES.trialTokensExhausted };
    }
    return { ok: false, message: BILLING_ACCESS_MESSAGES.inactive };
  }

  return { ok: true, business: refreshed };
}

/** Snapshot síncrono cuando ya se tiene la fila `subscription` (tests / APIs). */
export function evaluateSubscriptionRowAccess(
  business: business,
  sub: subscription | null
): {
  access_ok: boolean;
  reason: "ok" | "no_subscription" | "trial_ended" | "trial_tokens" | "inactive";
} {
  if (!sub) {
    return { access_ok: false, reason: "no_subscription" };
  }
  const access = subscriptionGrantsAccess(business, sub);
  if (!access.ok) {
    return { access_ok: false, reason: access.reason };
  }
  return { access_ok: true, reason: "ok" };
}
