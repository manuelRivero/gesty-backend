import type { HumanIntentEffect, HumanIntentRecord } from './humanIntentState.service';
import { reconcileActiveHumanIntent } from './humanIntentState.service';
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