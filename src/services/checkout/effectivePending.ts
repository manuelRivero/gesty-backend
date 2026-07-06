import type { ConversationMetadata } from '../productQuery/types';
import type { CheckoutPendingAction } from './pendingActionRegistry';

export type CheckoutSnapshot = {
  fulfillmentType: string | null | undefined;
  paymentMethod: string | null | undefined;
};

export type EffectivePending = {
  action: CheckoutPendingAction | null;
  question: string | null;
  /** `true` cuando metadata apuntaba a un campo ya completo en el snapshot. */
  stale: boolean;
  staleReason: string | null;
};

function isSnapshotFieldComplete(
  action: CheckoutPendingAction,
  snapshot: CheckoutSnapshot
): boolean {
  if (action === 'fulfillment_type') {
    return Boolean(snapshot.fulfillmentType?.trim());
  }
  if (action === 'payment_method') {
    return Boolean(snapshot.paymentMethod?.trim());
  }
  return false;
}

/**
 * Pending efectivo: ignora `checkout_pending_*` si el snapshot del draft ya tiene
 * el campo que la acción esperaba completar.
 */
export function effectivePending(params: {
  metadata: ConversationMetadata;
  snapshot: CheckoutSnapshot;
}): EffectivePending {
  const action = params.metadata.checkout_pending_action ?? null;
  if (!action) {
    return { action: null, question: null, stale: false, staleReason: null };
  }

  if (isSnapshotFieldComplete(action, params.snapshot)) {
    return {
      action: null,
      question: null,
      stale: true,
      staleReason: `${action}_already_in_snapshot`,
    };
  }

  return {
    action,
    question: params.metadata.checkout_pending_question?.trim() || null,
    stale: false,
    staleReason: null,
  };
}
