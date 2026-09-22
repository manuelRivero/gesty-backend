/**
 * Fact `pendingReservationDishFaq`: el cliente pidió platos para la mesa
 * y todavía no corrimos el FAQ (falta partySize o el ReAct se fue a fecha).
 * Ownership de turno — no es Goal. El nodo cumple el FAQ cuando hay N.
 */

import { prisma } from '../../lib/prisma';
import type { EnrichedContext } from '../../controllers/webhook/types';
import { omitConversationMetadataKeys } from '../../repositories/conversationState.repository';
import type { ConversationMetadata } from '../productQuery/types';
import { normalizeMetadata } from '../productQuery/utils';
import { hasSavedReservationPartySize } from './dishFaqPartySizeGate';

export const PENDING_RESERVATION_DISH_FAQ_KEY = 'pendingReservationDishFaq' as const;

export const CANONICAL_DISH_FAQ_USER_MESSAGE =
  'qué platos sirven para la reserva';

export type PendingReservationDishFaq = {
  reason: string;
  originalUserMessage?: string;
  setAt: string;
};

export const buildPendingReservationDishFaq = (params: {
  reason?: string | null;
  originalUserMessage?: string | null;
}): PendingReservationDishFaq => {
  const reason = params.reason?.trim() || 'sugerir platos por raciones';
  const original = params.originalUserMessage?.trim();
  return {
    reason,
    ...(original ? { originalUserMessage: original } : {}),
    setAt: new Date().toISOString(),
  };
};

export const getPendingReservationDishFaq = (
  metadata: unknown
): PendingReservationDishFaq | null => {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  const raw = meta.pendingReservationDishFaq;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) return null;
  if (typeof raw.setAt !== 'string' || !raw.setAt) return null;
  return {
    reason: raw.reason.trim(),
    setAt: raw.setAt,
    ...(typeof raw.originalUserMessage === 'string' && raw.originalUserMessage.trim()
      ? { originalUserMessage: raw.originalUserMessage.trim() }
      : {}),
  };
};

export const readPendingReservationDishFaq = async (
  conversationId: string
): Promise<PendingReservationDishFaq | null> => {
  const cs = await prisma.conversation_state.findFirst({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  return getPendingReservationDishFaq(cs?.metadata);
};

export const shouldFulfillReservationDishFaq = (params: {
  pending: PendingReservationDishFaq | null;
  partySize?: number | null;
}): boolean =>
  params.pending != null && hasSavedReservationPartySize(params.partySize);

export const dishFaqDelegationReasonForPartySize = (partySize: number): string =>
  `sugerir platos para ${partySize} por raciones`;

export const dishFaqUserMessageForHybrid = (
  pending: PendingReservationDishFaq
): string => pending.originalUserMessage?.trim() || CANONICAL_DISH_FAQ_USER_MESSAGE;

export const clearPendingReservationDishFaq = async (
  conversationId: string
): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [
    PENDING_RESERVATION_DISH_FAQ_KEY,
  ]);
};

/** Snapshot del híbrido: consulta de platos + N ya persistido (el ctx del turno puede ser solo “Somos 6”). */
export const withDishFaqEnrichedContext = (
  ctx: EnrichedContext,
  params: { userText: string; partySize: number; reason: string }
): EnrichedContext => {
  const prevMeta = normalizeMetadata(ctx.conversationState?.metadata) as ConversationMetadata;
  return {
    ...ctx,
    message: {
      ...(typeof ctx.message === 'object' && ctx.message ? ctx.message : {}),
      type: 'text',
      text: { body: params.userText },
    },
    conversationState: {
      ...ctx.conversationState,
      metadata: {
        ...prevMeta,
        reservation_agent_active: true,
        reservation_draft: {
          ...prevMeta.reservation_draft,
          partySize: params.partySize,
        },
        reservation_faq_delegation: {
          reason: params.reason,
          delegatedAt: new Date().toISOString(),
        },
      },
    },
  };
};

/** Ledger del agente de reservas: el Paso actual (fecha) no manda si hay FAQ adeudada. */
export const buildPendingReservationDishFaqContextLines = (
  metadata: unknown
): string[] => {
  const pending = getPendingReservationDishFaq(metadata);
  if (!pending) return [];
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  const party = meta.reservation_draft?.partySize;
  if (hasSavedReservationPartySize(party)) {
    return [
      '- FAQ de platos para la mesa: pendiente y YA hay personas. ' +
        'delegate_to_main AHORA (sugerir platos por raciones). ' +
        'El Paso actual (fecha/horario) NO aplica este turno.',
    ];
  }
  return [
    '- FAQ de platos para la mesa: pendiente. Pedí personas y save_reservation_party_size; ' +
      'no pidas fecha ni horarios.',
  ];
};
