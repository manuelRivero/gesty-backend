import type { subscription } from "@prisma/client";
import { isActiveSubscriptionStatus } from "../../constants/billing";

/**
 * Estados de ciclo de vida expuestos al admin (`GET /admin/billing/subscription`)
 * y usados internamente por los distintos guards de las operaciones de
 * facturación (checkout inicial, cancelación, reactivación, cambio de
 * plan). Única fuente de verdad para "en qué situación está la
 * suscripción" — cada operación decide qué hacer con cada estado, pero
 * ninguna reimplementa la clasificación.
 *
 * - `none`: no hay fila, o hay una fila placeholder sin suscripción de
 *   Stripe real todavía (`stripe_subscription_id` null).
 * - `active`: activa/trialing, sin cancelación programada vigente.
 * - `active_canceling`: activa/trialing con `cancel_at_period_end=true` y
 *   el período pagado todavía no terminó — sigue dando acceso.
 * - `past_due`: `past_due`/`unpaid`/`incomplete` — pago pendiente de
 *   regularizar, pero la suscripción de Stripe sigue existiendo y puede
 *   recuperarse (no es una cancelación efectiva).
 * - `expired`: cancelada/terminada efectivamente, sin nada que gestionar.
 * - `unknown`: cualquier otro status no contemplado — nunca se trata como
 *   activo por omisión.
 */
export type SubscriptionLifecycleState =
  | "none"
  | "active"
  | "active_canceling"
  | "past_due"
  | "expired"
  | "unknown";

/** Estados de Stripe con pago pendiente de regularizar, no cancelados
 * definitivamente — potencialmente recuperables por Stripe o por el
 * cliente desde el Portal. */
export const RECOVERABLE_SUBSCRIPTION_STATUSES = new Set([
  "past_due",
  "unpaid",
  "incomplete",
]);

const KNOWN_TERMINAL_STATUSES = new Set([
  "canceled",
  "cancelled",
  "incomplete_expired",
  "ended",
]);

export function classifySubscriptionLifecycle(
  sub: subscription | null
): SubscriptionLifecycleState {
  if (!sub || !sub.stripe_subscription_id) {
    return "none";
  }

  const status = sub.status.trim().toLowerCase();

  if (isActiveSubscriptionStatus(status)) {
    if (sub.cancel_at_period_end && new Date() <= sub.current_period_end) {
      return "active_canceling";
    }
    return "active";
  }

  if (RECOVERABLE_SUBSCRIPTION_STATUSES.has(status)) {
    return "past_due";
  }

  if (KNOWN_TERMINAL_STATUSES.has(status)) {
    return "expired";
  }

  return "unknown";
}

export type BillingActionsDto = {
  can_checkout: boolean;
  /** @deprecated Coarse — no distingue upgrade de downgrade. Usar
   * `can_upgrade`/`can_downgrade`. Se mantiene por compatibilidad: es
   * `can_upgrade || can_downgrade`, nunca más permisivo que ambos juntos. */
  can_change_plan: boolean;
  can_cancel: boolean;
  can_reactivate: boolean;
  can_open_portal: boolean;
  /** Upgrade: permitido en `active` y también en `active_canceling` (un
   * upgrade libera la cancelación programada, ver `subscriptionChangePlan.service.ts`). */
  can_upgrade: boolean;
  /** Downgrade: solo en `active` — en `active_canceling` queda ambiguo
   * (¿gana el downgrade programado o la cancelación programada?) y el
   * backend lo rechaza explícitamente; no ofrecerlo en la UI para ese
   * estado evita que el admin muestre una acción que el backend va a
   * rechazar con 409. */
  can_downgrade: boolean;
};

/**
 * Deriva las acciones disponibles a partir del estado. Es una guía para la
 * interfaz — cada endpoint (`cancel`, `reactivate`, `change-plan`) vuelve a
 * validar sus propias precondiciones contra el estado real al momento de
 * ejecutar, no confía en que el cliente haya respetado estos flags. No
 * depende de qué plan es cuál: la ambigüedad por capacidades distintas
 * (`planComparison.ts`) solo se puede resolver por par de planes, no por
 * estado de la suscripción — eso lo sigue validando `changeSubscriptionPlan`
 * en el momento, estos flags son solo "en este estado, tiene sentido
 * ofrecer la opción".
 */
export function deriveBillingActions(
  state: SubscriptionLifecycleState
): BillingActionsDto {
  const canUpgrade = state === "active" || state === "active_canceling";
  const canDowngrade = state === "active";
  return {
    can_checkout: state === "none" || state === "expired" || state === "unknown",
    can_change_plan: canUpgrade || canDowngrade,
    can_cancel: state === "active",
    can_reactivate: state === "active_canceling",
    can_open_portal:
      state === "active" || state === "active_canceling" || state === "past_due",
    can_upgrade: canUpgrade,
    can_downgrade: canDowngrade,
  };
}
