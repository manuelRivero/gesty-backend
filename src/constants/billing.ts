/** Constantes y defaults de billing SaaS (suscripción obligatoria). */

export const DEFAULT_TRIAL_DAYS = 14;

/** Plan de tokens por defecto durante trial onboarding. */
export const DEFAULT_TRIAL_PLAN_CODE = "basic" as const;

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
