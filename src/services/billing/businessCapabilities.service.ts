/**
 * Resolución centralizada de capacidades comerciales por negocio.
 *
 * Dos capacidades independientes:
 * - `shopping`: autoriza el acceso público a Shopping (vitrina + pedidos web).
 * - `ai`: autoriza la ejecución de IA conversacional (grafo, STT, visión,
 *   enriquecimiento, embeddings, etc.).
 *
 * Fuente de verdad: la fila `subscription` del negocio y el `plan` asociado
 * (`plan.ai_enabled` / `plan.shopping_enabled`). Explícitamente NO son fuente
 * de verdad: `plan.code` (nombre, no autorización), `business.ai_plan`
 * (string de display heredado), `business.features` (JSON sin consumidores)
 * ni `business_config.storefront_enabled`/`bot_enabled` (controles
 * operativos, no entitlements comerciales).
 *
 * `business.ai_blocked` sí participa, pero solo como restricción adicional
 * sobre IA (bloqueo manual de superadmin / cupo agotado): nunca puede
 * conceder una capacidad que el plan no otorga, solo denegarla.
 *
 * Sin caché y sin sincronización a `business`: se deriva en cada llamada
 * directamente desde `subscription`+`plan`, así que no hay estado que pueda
 * quedar desactualizado (ver docs/planes-accion/PLAN-ACCION-SHOPPING-ONLY.md,
 * sección de brechas E1/E6/E7 de la auditoría previa).
 *
 * Fail-closed: cualquier excepción de resolución, negocio inexistente,
 * suscripción ausente o plan no resoluble deniega la capacidad en cuestión.
 * Nunca se concede acceso por inferencia.
 */

import type { business, plan as PlanRow, subscription } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import {
  isActiveSubscriptionStatus,
  isInactiveSubscriptionStatus,
} from '../../constants/billing';
import { getEffectiveAiTokenLimit } from '../ai/aiLimits';

export type CapabilityReason =
  | 'ok'
  | 'trial'
  | 'no_business'
  | 'no_subscription'
  | 'trial_ended'
  | 'trial_invalid_status'
  | 'trial_tokens'
  | 'inactive'
  | 'plan_unresolved'
  | 'period_ended'
  | 'plan_ai_disabled'
  | 'plan_shopping_disabled'
  | 'ai_blocked'
  | 'resolution_error';

export type CapabilityResult = {
  allowed: boolean;
  reason: CapabilityReason;
};

export type BusinessCapabilities = {
  ai: CapabilityResult;
  shopping: CapabilityResult;
};

/**
 * Forma mínima de `subscription` (+ `plan` asociado) que necesitan los
 * deciders puros. `resolveActivePublicBusiness`/`listPublicStorefronts`
 * pueden construirla desde su propia query (misma fila, sin round-trip
 * extra) en vez de pasar por el resolver async completo.
 */
export type SubscriptionForCapabilities = Pick<
  subscription,
  'status' | 'is_trial' | 'trial_end' | 'cancel_at_period_end' | 'current_period_end' | 'plan_id'
> & {
  plan: Pick<PlanRow, 'ai_enabled' | 'shopping_enabled'> | null;
};

const allow = (reason: CapabilityReason): CapabilityResult => ({ allowed: true, reason });
const deny = (reason: CapabilityReason): CapabilityResult => ({ allowed: false, reason });

const DENY_ALL = (reason: CapabilityReason): BusinessCapabilities => ({
  ai: deny(reason),
  shopping: deny(reason),
});

/**
 * `cancel_at_period_end=true` mantiene el acceso hasta `current_period_end`
 * (D6 de la auditoría). No es un período de gracia nuevo: es honrar lo ya
 * pagado. Para suscripciones sin cancelación programada, siempre vigente.
 */
function paidPeriodStillValid(
  sub: Pick<subscription, 'cancel_at_period_end' | 'current_period_end'>
): boolean {
  if (!sub.cancel_at_period_end) return true;
  return new Date() <= sub.current_period_end;
}

/**
 * Capacidad de Shopping — pura, sin I/O. No depende de cupo de tokens ni de
 * `ai_blocked`: Shopping no es IA.
 */
export function decideShoppingCapability(
  sub: SubscriptionForCapabilities | null
): CapabilityResult {
  if (!sub) return deny('no_subscription');

  if (sub.is_trial) {
    if (sub.trial_end != null && new Date() > sub.trial_end) return deny('trial_ended');
    if (!isActiveSubscriptionStatus(sub.status)) return deny('trial_invalid_status');
    return allow('trial');
  }

  // Suscripción de pago: requiere un plan resoluble. `plan_id = null`, un
  // plan borrado o un precio de Stripe no mapeado NUNCA infieren capacidades
  // de otro plan — se deniega explícitamente (D5 de la auditoría).
  if (!sub.plan) return deny('plan_unresolved');
  if (isInactiveSubscriptionStatus(sub.status)) return deny('inactive');
  if (!paidPeriodStillValid(sub)) return deny('period_ended');

  return sub.plan.shopping_enabled ? allow('ok') : deny('plan_shopping_disabled');
}

/**
 * Capacidad de IA — pura, sin I/O. `aiBlocked` y `trialTokensExhausted` son
 * restricciones operativas adicionales (cupo agotado, bloqueo manual de
 * superadmin): solo pueden denegar, nunca conceder por encima del plan.
 */
export function decideAiCapability(
  sub: SubscriptionForCapabilities | null,
  opts: { aiBlocked: boolean; trialTokensExhausted: boolean }
): CapabilityResult {
  if (!sub) return deny('no_subscription');

  if (sub.is_trial) {
    if (sub.trial_end != null && new Date() > sub.trial_end) return deny('trial_ended');
    if (!isActiveSubscriptionStatus(sub.status)) return deny('trial_invalid_status');
    if (opts.trialTokensExhausted) return deny('trial_tokens');
    if (opts.aiBlocked) return deny('ai_blocked');
    return allow('trial');
  }

  if (!sub.plan) return deny('plan_unresolved');
  if (isInactiveSubscriptionStatus(sub.status)) return deny('inactive');
  if (!paidPeriodStillValid(sub)) return deny('period_ended');
  if (opts.aiBlocked) return deny('ai_blocked');

  return sub.plan.ai_enabled ? allow('ok') : deny('plan_ai_disabled');
}

/**
 * Resolución completa (con I/O) de ambas capacidades de un negocio. Punto de
 * entrada para todo lo que no sea Shopping público (que ya trae
 * subscription+plan en su propia query): grafo de WhatsApp, STT, visión de
 * comprobantes, interpretación de promociones, enriquecimiento de productos.
 */
export async function resolveBusinessCapabilities(
  businessId: string
): Promise<BusinessCapabilities> {
  try {
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (!business) return DENY_ALL('no_business');

    const sub = await prisma.subscription.findUnique({
      where: { business_id: businessId },
      include: { plan: true },
    });

    if (!sub) return DENY_ALL('no_subscription');

    if (sub.plan_id != null && !sub.plan) {
      // Suscripción de pago apuntando a un `plan_id` que ya no existe (o un
      // precio de Stripe que nunca se mapeó a un plan — ver
      // `stripeSubscriptionSync.service.ts`). No se infiere nada: queda
      // denegado y se deja evidencia para investigar.
      console.warn(
        JSON.stringify({
          event: '[billing:capabilities] plan_unresolved',
          businessId,
          subscriptionId: sub.id,
          planId: sub.plan_id,
        })
      );
    }

    const trialTokensExhausted =
      sub.is_trial === true &&
      business.ai_monthly_tokens_used >= getEffectiveAiTokenLimit(business);

    return {
      ai: decideAiCapability(sub, {
        aiBlocked: business.ai_blocked,
        trialTokensExhausted,
      }),
      shopping: decideShoppingCapability(sub),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: '[billing:capabilities] resolution_error',
        businessId,
        error: String(error),
      })
    );
    return DENY_ALL('resolution_error');
  }
}

/** Reexport de tipo de conveniencia para callers que ya tienen `business` en mano. */
export type { business as BusinessRow };
