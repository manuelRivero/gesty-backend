/** Constantes y defaults de billing SaaS (suscripción obligatoria). */

import {
  TOKENS_PER_CONVERSATION,
  TRIAL_CONVERSATIONS,
  tokenLimitFromConversations,
} from "./planCatalog";

export const DEFAULT_TRIAL_DAYS = 7;

/**
 * Cupo de tokens del trial ≈ 500 conv. de la landing (no es un plan pago).
 */
export const DEFAULT_TRIAL_TOKEN_LIMIT =
  tokenLimitFromConversations(TRIAL_CONVERSATIONS);

/** Código interno en `business.ai_plan` mientras dura el trial (no es plan Stripe). */
export const DEFAULT_TRIAL_PLAN_CODE = "trial" as const;

export { TOKENS_PER_CONVERSATION, TRIAL_CONVERSATIONS };

export const ACTIVE_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
] as const;

export const INACTIVE_SUBSCRIPTION_STATUSES = [
  "past_due",
  "unpaid",
  "canceled",
  "cancelled",
  "incomplete_expired",
  "ended",
  "incomplete",
] as const;

export type InactiveSubscriptionStatus =
  (typeof INACTIVE_SUBSCRIPTION_STATUSES)[number];

export function isInactiveSubscriptionStatus(status: string): boolean {
  return (INACTIVE_SUBSCRIPTION_STATUSES as readonly string[]).includes(
    status.trim().toLowerCase()
  );
}
