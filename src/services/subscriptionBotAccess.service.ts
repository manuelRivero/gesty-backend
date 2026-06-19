import type { business } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { resetIfNeeded } from "./ai/aiUsage.service";
import { getEffectiveAiTokenLimit } from "./ai/aiLimits";
import { formatBotUserMessage } from "./productQuery/utils";

const MESSAGES = {
  trialDateEnded: formatBotUserMessage(
    'Período de prueba',
    '⏳',
    'Tu período de prueba finalizó. Contratá un plan para seguir usando el asistente automático.'
  ),
  trialTokensExhausted: formatBotUserMessage(
    'Tokens agotados',
    '⚡',
    'Se agotaron los tokens de tu período de prueba. Actualizá tu plan para continuar.'
  ),
} as const;

/**
 * Suscripción en trial activa si no venció por fecha (`trial_end`) ni por cupo de tokens.
 * Negocios sin fila `subscription` o con `is_trial` falso siguen el flujo habitual (límites vía `ai_blocked` / openai).
 */
export async function evaluateSubscriptionForBotAi(
  business: business
): Promise<
  | { ok: true; business: business }
  | { ok: false; message: string }
> {
  const refreshed = await resetIfNeeded(business);

  const sub = await prisma.subscription.findUnique({
    where: { business_id: refreshed.id },
    select: { is_trial: true, trial_end: true }
  });

  if (!sub?.is_trial) {
    return { ok: true, business: refreshed };
  }

  if (sub.trial_end != null && new Date() > sub.trial_end) {
    return { ok: false, message: MESSAGES.trialDateEnded };
  }

  const limit = getEffectiveAiTokenLimit(refreshed);
  if (refreshed.ai_monthly_tokens_used >= limit) {
    return { ok: false, message: MESSAGES.trialTokensExhausted };
  }

  return { ok: true, business: refreshed };
}
