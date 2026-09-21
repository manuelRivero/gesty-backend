/**
 * Limpia el estado de sesión de *reserva* al cancelar / abandonar / confirmar.
 *
 * Simétrico a `clearOrderSessionAfterCancel`: wipe del dominio reserva + Ledger
 * asociado. No toca carrito, checkout, shortlist de pedido ni onboarding.
 */

import { prisma } from '../lib/prisma';
import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
  updateConversationState,
} from '../repositories';
import type { ConversationMetadata } from './productQuery/types';
import { normalizeMetadata } from './productQuery/utils';

const RESERVATION_SESSION_OMIT_KEYS = [
  'reservation_agent_active',
  'reservation_draft',
  'reservation_faq_delegation',
] as const;

/** Goals/alerts del Ledger ligados a reserva (no a pedido). */
const RESERVATION_LEDGER_KEYS = ['COMPLETAR_RESERVA', 'RESERVA_PROXIMA'] as const;

/**
 * Tras cancelar/abandonar/confirmar una reserva: omite draft + flags de sesión
 * y limpia COMPLETAR_RESERVA / RESERVA_PROXIMA del Ledger.
 *
 * Preserva: sesión de pedido (carrito, shortlist, party, checkout), onboarding,
 * ambassador_ref.
 */
export async function clearReservationSessionAfterCancel(
  conversationId: string
): Promise<void> {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  const meta = normalizeMetadata(row?.metadata);

  const prevLedger = meta.intentLedger ?? {};
  const nextLedger: NonNullable<ConversationMetadata['intentLedger']> = {
    ...prevLedger,
  };
  for (const key of RESERVATION_LEDGER_KEYS) {
    delete nextLedger[key];
  }

  await omitConversationMetadataKeys(conversationId, [
    ...RESERVATION_SESSION_OMIT_KEYS,
  ]);

  await patchConversationMetadata(conversationId, {
    welcomeEligible: true,
  });

  if (Object.keys(nextLedger).length === 0) {
    await omitConversationMetadataKeys(conversationId, ['intentLedger']);
  } else {
    await patchConversationMetadata(conversationId, { intentLedger: nextLedger });
  }

  try {
    await updateConversationState(conversationId, { mode: 'GLOBAL' });
  } catch {
    /* sin fila de state: no bloquea */
  }
}
