/**
 * Contadores de rechazo (V-10) viven en el Ledger de OBTENER_NOMBRE /
 * OBTENER_DIRECCION — no en la raíz de metadata. Aunque estos Goals todavía
 * no entren al ranker del híbrido (viven bajo Ownership de checkout/onboarding),
 * el Ledger es la única fuente del contador (Fase B.1).
 */

import { patchIntentLedgerEntry } from '../intentLedger.repository';
import type { ConversationMetadata } from '../productQuery/types';
import { normalizeMetadata } from '../productQuery/utils';
import { prisma } from '../../lib/prisma';
import { omitConversationMetadataKeys } from '../../repositories';

export type RefusalGoalType = 'OBTENER_NOMBRE' | 'OBTENER_DIRECCION';

const readRefusalFromMeta = (
  meta: ConversationMetadata,
  type: RefusalGoalType
): number => meta.intentLedger?.[type]?.refusalCount ?? 0;

export const getRefusalCount = (metadata: unknown, type: RefusalGoalType): number => {
  const meta = normalizeMetadata(metadata);
  return readRefusalFromMeta(meta, type);
};

export const incrementRefusalCount = async (
  conversationId: string,
  type: RefusalGoalType
): Promise<number> => {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  const meta = normalizeMetadata(row?.metadata);
  const current = readRefusalFromMeta(meta, type);
  const next = current + 1;
  const prev = meta.intentLedger?.[type] ?? {};
  await patchIntentLedgerEntry(conversationId, type, {
    ...prev,
    refusalCount: next,
  });
  // Limpia el proxy legacy si todavía existiera (flip B.1).
  const legacyKey =
    type === 'OBTENER_NOMBRE' ? 'name_refusal_count' : 'address_refusal_count';
  if (meta[legacyKey] != null) {
    await omitConversationMetadataKeys(conversationId, [legacyKey]);
  }
  return next;
};

/** Resetea ambos contadores de captura al cerrar la sesión de checkout. */
export const clearCaptureRefusalLedger = async (conversationId: string): Promise<void> => {
  await patchIntentLedgerEntry(conversationId, 'OBTENER_NOMBRE', {});
  await patchIntentLedgerEntry(conversationId, 'OBTENER_DIRECCION', {});
  await omitConversationMetadataKeys(conversationId, [
    'name_refusal_count',
    'address_refusal_count',
  ]);
};
