/**
 * Escritura del Ledger de la familia Intent (ADR-0007), indexado por tipo
 * bajo una única clave de metadata (`intentLedger`).
 *
 * `patchConversationMetadata` mergea superficialmente: escribir
 * `{ intentLedger: { COMPLETAR_PEDIDO: ... } }` directo reemplazaría el
 * objeto `intentLedger` entero, borrando cualquier otra entrada (ej.
 * `COMPLETAR_RESERVA`) que coexista. Este helper lee el `intentLedger`
 * actual y solo reemplaza la entrada del tipo indicado.
 */

import { prisma } from '../lib/prisma';
import { patchConversationMetadata } from '../repositories';
import type { ConversationMetadata } from './productQuery/types';
import { normalizeMetadata } from './productQuery/utils';

type IntentLedger = NonNullable<ConversationMetadata['intentLedger']>;
type IntentLedgerKey = keyof IntentLedger;

export const patchIntentLedgerEntry = async <K extends IntentLedgerKey>(
  conversationId: string,
  key: K,
  value: IntentLedger[K]
): Promise<void> => {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  const meta: ConversationMetadata = normalizeMetadata(row?.metadata);
  await patchConversationMetadata(conversationId, {
    intentLedger: { ...meta.intentLedger, [key]: value },
  });
};
