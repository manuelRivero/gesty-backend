/**
 * Fuente única de escritura de `reservation_draft` (P0.1, R-A).
 *
 * `patchConversationMetadata` hace merge shallow del primer nivel: escribir
 * `{ reservation_draft: { date } }` reemplaza la clave entera y borra
 * cualquier otro campo ya cargado (slotId, time, partySize, environmentId).
 * Este helper lee el draft actual y lo mergea antes de persistir, para que
 * ningún write pueda borrar un Fact que no le pertenece (D1).
 *
 * Todas las tools de escritura (`save_reservation_date`,
 * `save_reservation_party_size`, `save_reservation_environment`) y los
 * handlers de payload del nodo (`RESERVATION_SLOT:*`, `RESERVATION_ENV:*`)
 * deben pasar por acá — nunca llamar `patchConversationMetadata` con
 * `reservation_draft` directamente.
 */

import { prisma } from '../../lib/prisma';
import { patchConversationMetadata } from '../../repositories/conversationState.repository';

export interface ReservationDraftData {
  date?: string;
  slotId?: string;
  time?: string;
  endTime?: string;
  partySize?: number;
  environmentId?: string | null;
}

/** Lee el draft actual desde la DB (lectura fresca, no el snapshot del turno). */
export async function readReservationDraft(
  conversationId: string
): Promise<ReservationDraftData> {
  const cs = await prisma.conversation_state.findFirst({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  if (!cs || typeof cs.metadata !== 'object' || cs.metadata === null) return {};
  const draft = (cs.metadata as Record<string, unknown>).reservation_draft;
  return draft && typeof draft === 'object' ? { ...(draft as ReservationDraftData) } : {};
}

/**
 * Mergea `partial` sobre el draft existente y persiste. Nunca reemplaza la
 * clave `reservation_draft` completa.
 */
export async function patchReservationDraft(
  conversationId: string,
  partial: Partial<ReservationDraftData>
): Promise<ReservationDraftData> {
  const existing = await readReservationDraft(conversationId);
  const merged = { ...existing, ...partial };
  await patchConversationMetadata(conversationId, { reservation_draft: merged });
  return merged;
}
