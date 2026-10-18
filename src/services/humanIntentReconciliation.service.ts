import type { HumanIntentEffect, HumanIntentRecord } from './humanIntentState.service';
import {
  HumanIntentStateError,
  cancelHumanIntent,
  getActiveHumanIntent,
  reconcileActiveHumanIntent,
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