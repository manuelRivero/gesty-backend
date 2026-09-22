/**
 * Lienzo en blanco: si después de un wipe de dominio no queda dueño,
 * el metadata vuelve a `{}`. El historial de mensajes no se corta acá.
 */

import { prisma } from '../lib/prisma';
import { normalizeMetadata } from './productQuery/utils';
import { hasReservationDraftInProgress } from './reservationCompletionGoal.service';
import { isReservationFaqMode } from './reservationFaqDelegation.service';

const hasActiveCartItems = async (conversationId: string): Promise<boolean> => {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      business_id: true,
      customer: { select: { phone_number: true } },
    },
  });
  const phone = conversation?.customer?.phone_number;
  if (!conversation || !phone) return false;

  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: conversation.business_id,
      customer_phone: phone,
      status: 'active',
    },
    select: { _count: { select: { draft_order_item: true } } },
  });
  return (draft?._count.draft_order_item ?? 0) > 0;
};

export const shouldClearConversationCanvas = (params: {
  metadata: unknown;
  hasCartItems: boolean;
}): boolean => {
  const meta = normalizeMetadata(params.metadata);
  if (params.hasCartItems) return false;
  if (meta.checkout_active === true) return false;
  if (isReservationFaqMode(meta)) return false;
  if (hasReservationDraftInProgress(meta.reservation_draft)) return false;
  if (meta.onboarding_agent_active === true) return false;
  if (meta.onboarding_step != null && String(meta.onboarding_step).length > 0) {
    return false;
  }
  return true;
};

export const replaceConversationCanvas = async (
  conversationId: string
): Promise<void> => {
  await prisma.conversation_state.upsert({
    where: { conversation_id: conversationId },
    update: { mode: 'GLOBAL', metadata: {} },
    create: {
      conversation_id: conversationId,
      mode: 'GLOBAL',
      metadata: {},
    },
  });
  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastReferencedProductId: null },
    });
  } catch {
    /* conversación inexistente */
  }
};

/** Tras un wipe de dominio: si no queda dueño, metadata `{}`. */
export const maybeClearConversationCanvas = async (
  conversationId: string
): Promise<boolean> => {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  const hasCartItems = await hasActiveCartItems(conversationId);
  if (!shouldClearConversationCanvas({ metadata: row?.metadata, hasCartItems })) {
    return false;
  }
  await replaceConversationCanvas(conversationId);
  return true;
};
