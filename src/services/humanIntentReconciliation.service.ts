import type { HumanGoal, HumanIntentEffect, HumanIntentRecord } from './humanIntentState.service';
import {
  HumanIntentStateError,
  cancelHumanIntent,
  getActiveHumanIntent,
  getHumanIntentState,
  notActiveMessage,
  reconcileActiveHumanIntent,
  resolveHumanIntentById,
} from './humanIntentState.service';
import { getPendingOrderLines } from './pendingOrderLines.service';
import { prisma } from '../lib/prisma';

export type RequestedWorkProgress = {
  tasks: Array<{ id: string; status: 'done' | 'pending' }>;
  complete: boolean;
};

/** Projects structured plan progress; completion additionally requires a persisted effect. */
export const deriveRequestedWorkProgress = (
  intent: HumanIntentRecord,
  metadata: unknown,
  effectPersisted: boolean
): RequestedWorkProgress => {
  const pending = getPendingOrderLines(metadata);
  const tasks = pending?.lines.map((line) => ({
    id: line.id,
    status: line.status === 'done' || line.status === 'cancelled' ? 'done' as const : 'pending' as const,
  })) ?? [];
  return {
    tasks,
    complete:
      intent.goal === 'PEDIR' &&
      effectPersisted &&
      !pending?.lines.some((line) => line.status === 'active' || line.status === 'queued'),
  };
};

/** Common post-tool hook: re-reads business facts, then conditionally reconciles ACTIVE. */
export const reconcileHumanIntentAfterToolEffect = async (params: {
  conversationId: string;
  businessId: string;
  customerPhone: string;
  effect: HumanIntentEffect;
}): Promise<HumanIntentRecord | null> => {
  const [conversationState, draft] = await Promise.all([
    prisma.conversation_state.findUnique({
      where: { conversation_id: params.conversationId },
      select: { metadata: true },
    }),
    prisma.draft_order.findFirst({
      where: {
        business_id: params.businessId,
        customer_phone: params.customerPhone,
        status: 'active',
      },
      select: {
        draft_order_item: {
          select: { product_id: true },
        },
      },
    }),
  ]);
  const effectPersisted = Boolean(
    params.effect.reference &&
    draft?.draft_order_item.some((item) => item.product_id === params.effect.reference)
  );

  return reconcileActiveHumanIntent(
    params.conversationId,
    params.effect,
    (intent) => deriveRequestedWorkProgress(intent, conversationState?.metadata, effectPersisted).complete
  );
};

/**
 * True only when the ACTIVE intent's order-line queue ended with nothing ever
 * added to the cart: every line closed `cancelled` (none `done` — `done` only
 * ever follows a real cart write, see cart.service.ts / add_cart_item in
 * tools/index.ts) and no `active`/`queued` line remains open.
 *
 * Deliberately independent from `deriveRequestedWorkProgress.complete`: that
 * one requires a persisted effect (success); this is its complement — closed,
 * but with no persisted effect at all (total abandonment, not completion).
 *
 * Binding to "the right" intent reuses the same precision the existing
 * success path already relies on (goal === 'PEDIR' on the single ACTIVE
 * record) — there is no intentId carried down to `pendingOrderLines` to bind
 * more precisely than that (see `reconcileOrderLinesPlan` in
 * pendingOrderLines.service.ts, documented, pre-existing limitation). A
 * `pendingOrderLines` queue is a conversation-wide singleton, so "the queue"
 * and "the one ACTIVE human intent" coincide by construction, same as today's
 * success path.
 */
export const isPedirOrderFullyAbandoned = (
  intent: HumanIntentRecord,
  metadata: unknown,
  draftHasAnyItem: boolean
): boolean => {
  if (intent.goal !== 'PEDIR') return false;
  if (draftHasAnyItem) return false;
  const pending = getPendingOrderLines(metadata);
  if (!pending || pending.lines.length === 0) return false;
  const hasOpenLines = pending.lines.some(
    (line) => line.status === 'active' || line.status === 'queued'
  );
  if (hasOpenLines) return false;
  return pending.lines.every((line) => line.status === 'cancelled');
};

/** Exact message `requireOpenIntent` throws via `cancelHumanIntent` when the
 *  target already moved to a terminal status (humanIntentState.service.ts) —
 *  matched verbatim (including the intentId) so a genuinely different
 *  HumanIntentStateError (e.g. "Unknown human intent", a malformed-state
 *  error) is never mistaken for a lost race and swallowed. */
const alreadyTerminalMessage = (intentId: string): string =>
  `Human intent ${intentId} is already terminal`;

/**
 * Companion to `reconcileHumanIntentAfterToolEffect`, called separately (not
 * folded into it): "the tool effect that cancelled a line succeeded" and "the
 * PEDIR intent above it is now moot" are different facts about different
 * layers. Closes the ACTIVE PEDIR intent as CANCELLED — never RESOLVED, since
 * there is no successful outcome to record — only on total abandonment.
 *
 * Idempotent sequentially (once cancelled, it is no longer the ACTIVE intent,
 * so a later call finds nothing matching and no-ops) AND under concurrency:
 * two calls can both read the same ACTIVE intent before either writes (no
 * lock on this read), so both may reach `cancelHumanIntent`. The loser is
 * serialized behind `cancelHumanIntent`'s own advisory lock, rereads the
 * now-terminal state, and throws `HumanIntentStateError` — caught here and
 * treated as "lost the race, nothing left to close", not as a failure. Any
 * other `HumanIntentStateError` (a different bug) still propagates.
 */
export const closeAbandonedPedirIntent = async (params: {
  conversationId: string;
  businessId: string;
  customerPhone: string;
}): Promise<HumanIntentRecord | null> => {
  const [conversationState, draft, active] = await Promise.all([
    prisma.conversation_state.findUnique({
      where: { conversation_id: params.conversationId },
      select: { metadata: true },
    }),
    prisma.draft_order.findFirst({
      where: {
        business_id: params.businessId,
        customer_phone: params.customerPhone,
        status: 'active',
      },
      select: {
        draft_order_item: { select: { product_id: true } },
      },
    }),
    getActiveHumanIntent(params.conversationId),
  ]);
  if (!active) return null;
  const draftHasAnyItem = Boolean(draft?.draft_order_item.length);
  if (!isPedirOrderFullyAbandoned(active, conversationState?.metadata, draftHasAnyItem)) {
    return null;
  }
  try {
    return await cancelHumanIntent(params.conversationId, active.id);
  } catch (error) {
    if (
      error instanceof HumanIntentStateError &&
      error.message === alreadyTerminalMessage(active.id)
    ) {
      return null;
    }
    throw error;
  }
};

/**
 * Goals cuyo `request` (p. ej. `request.products` de PEDIR) puede re-derivar
 * líneas de pedido o volver a condicionar un turno posterior sobre un pedido
 * que ya terminó (cancelado o completado). Deliberadamente NO incluye
 * `SEGUIR_PEDIDO` (consultar el estado de una orden YA creada: ese objetivo
 * sigue vivo después de que la orden se cancela o se completa — es lo que
 * permite seguir consultando su estado), ni `EXPLORAR`/`RESERVAR`/
 * `CONSULTAR_NEGOCIO`/`SOPORTE_HUMANO` (otros dominios, ajenos al cierre de
 * este pedido).
 */
const ORDER_DOMAIN_GOALS: readonly HumanGoal[] = [
  'PEDIR',
  'GESTIONAR_PEDIDO',
  'COMPLETAR_COMPRA',
  'CANCELAR_COMPRA',
];

export type OrderDomainCloseReason = 'cancelled' | 'completed';

/** Goal cuyo intent, si está ACTIVE en este cierre, se resuelve como logrado (RESOLVED) en vez de abandonado (CANCELLED). */
const resolvingGoalByReason: Record<OrderDomainCloseReason, HumanGoal> = {
  cancelled: 'CANCELAR_COMPRA',
  completed: 'COMPLETAR_COMPRA',
};

const effectKindByReason: Record<OrderDomainCloseReason, string> = {
  cancelled: 'order_cancelled',
  completed: 'order_completed',
};

/**
 * Cierra, de forma idempotente, todo HumanIntentRecord ACTIVE/PENDING de
 * dominio pedido (ver `ORDER_DOMAIN_GOALS`) tras cancelar o completar un
 * pedido real — para que ninguno sobreviva a disparar una reconstrucción de
 * líneas (`ensurePendingOrderLinesFromRequest`) ni a un `RESUME_PENDING` sobre
 * datos obsoletos en un turno posterior.
 *
 * El goal que corresponde al motivo del cierre (`CANCELAR_COMPRA` al cancelar,
 * `COMPLETAR_COMPRA` al completar) se resuelve como logrado
 * (`resolveActiveHumanIntent`, solo cuando es el ACTIVE actual — ese intent sí
 * cumplió su objetivo). El resto de los goals de dominio pedido que sigan
 * abiertos se cancela (`cancelHumanIntent`, abandonados: el pedido al que
 * apuntaban ya no existe en esa forma).
 *
 * Idempotente: una segunda llamada no encuentra ningún record abierto de
 * dominio pedido y retorna sin mutar nada. Tolera la misma carrera que
 * `closeAbandonedPedirIntent` (dos llamadas concurrentes leyendo el mismo
 * ACTIVE antes de que cualquiera escriba): la perdedora se serializa detrás
 * del lock de `cancelHumanIntent`/`resolveHumanIntentById`, relee el estado
 * ya terminal (o ya no-ACTIVE) y se trata como "perdió la carrera, releer y
 * seguir", no como falla.
 *
 * Importante (fix TOCTOU): la decisión de qué record cerrar se toma sobre
 * una lectura (`getHumanIntentState`) tomada FUERA de cualquier lock — entre
 * esa lectura y la escritura, otro turno concurrente podría haber cambiado
 * cuál intent está ACTIVE. Por eso la resolución usa `resolveHumanIntentById`
 * (valida identidad del `intentId` Y que siga ACTIVE, de forma atómica,
 * dentro del mismo lock de la escritura) en vez de `resolveActiveHumanIntent`
 * (que resolvería "el que esté ACTIVE ahora", sin confirmar que sea el mismo
 * record que esta función decidió cerrar — ver humanIntentState.service.ts).
 * Si la carrera ya movió el estado, `resolveHumanIntentById` lanza
 * `notActiveMessage`, esta función lo trata como "perdió la carrera" y relee
 * en la siguiente iteración — nunca resuelve un record distinto del que
 * observó.
 *
 * No toca `pendingOrderLines` ni `productResolutions` — eso lo hace el
 * caller (ya cubierto por `ORDER_SESSION_OMIT_KEYS` al cancelar, o
 * explícitamente al completar el checkout).
 */
export const closeOrderDomainHumanIntents = async (params: {
  conversationId: string;
  reason: OrderDomainCloseReason;
  /** Id del draft/orden, solo para el `outcome.reference` de auditoría. */
  reference?: string;
}): Promise<void> => {
  const resolvingGoal = resolvingGoalByReason[params.reason];
  const effect: HumanIntentEffect = {
    kind: effectKindByReason[params.reason],
    ...(params.reference ? { reference: params.reference } : {}),
    occurredAt: new Date().toISOString(),
    success: true,
  };

  // Acotado: cada iteración cierra como máximo un record; cerrar el ACTIVE
  // puede promover un PENDING de dominio pedido a ACTIVE (promoteOldestPending
  // dentro de cancelHumanIntent), así que se relee tras cada cierre. También
  // es el límite ante la carrera: cada vuelta perdida por `notActiveMessage`/
  // `alreadyTerminalMessage` consume una iteración. Si se agota, el estado
  // puede haber quedado parcialmente cerrado — por eso SÍ lanza (ver abajo):
  // el caller debe tratarlo igual que cualquier otro fallo de reconciliación
  // (Fix 1), no asumir silenciosamente que terminó.
  for (let iterations = 0; iterations < 20; iterations += 1) {
    const state = await getHumanIntentState(params.conversationId);
    const target = state.records.find(
      (record) =>
        (record.status === 'ACTIVE' || record.status === 'PENDING') &&
        (ORDER_DOMAIN_GOALS as readonly string[]).includes(record.goal)
    );
    if (!target) return;

    try {
      if (target.status === 'ACTIVE' && target.goal === resolvingGoal) {
        await resolveHumanIntentById(params.conversationId, target.id, effect);
      } else {
        await cancelHumanIntent(params.conversationId, target.id);
      }
    } catch (error) {
      if (
        error instanceof HumanIntentStateError &&
        (error.message === alreadyTerminalMessage(target.id) ||
          error.message === notActiveMessage(target.id))
      ) {
        continue; // perdió la carrera: el estado ya avanzó, releer y seguir.
      }
      throw error;
    }
  }

  throw new Error(
    `closeOrderDomainHumanIntents: no se pudo vaciar los records de dominio pedido tras 20 iteraciones ` +
      `(conversationId=${params.conversationId}, reason=${params.reason}) — posible contienda sostenida ` +
      `o estado residual real; no asumir que quedó cerrado.`
  );
};