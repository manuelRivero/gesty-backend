/**
 * Adopción de personas del pedido al abrir la mesa (cambio de dominio).
 *
 * "Somos 6" es el mismo Fact en los dos dominios: si el híbrido eligió la
 * puerta de pedido y guardó el número ahí, al abrir la reserva se adopta en el
 * draft en vez de tirarlo. Es lo que hace que una elección de dominio errada no
 * le cueste nada al cliente — no repite el dato.
 *
 * Lectura **fresca**, nunca el snapshot del turno: el caso principal es el
 * híbrido llamando `save_party_size` y `start_reservation_session` en el MISMO
 * turno, y ahí `workingConversationState.metadata` todavía no tiene el Fact
 * (se refresca después del dispatch). Con el snapshot la adopción se saltea
 * justo cuando hace falta.
 *
 * Solo completa un hueco: si el draft ya tiene `partySize`, gana el draft.
 * Un número arrastrado de un pedido anterior de la misma conversación es visible
 * para el cliente en la tarjeta de confirmación antes de crear la reserva, así
 * que la adopción no puede cerrar una reserva con un dato que no vio.
 */

import { prisma } from '../../lib/prisma';
import { patchReservationDraft } from './draft.repository';
import { getRequestedPartySize, normalizeMetadata } from '../productQuery/utils';

export async function adoptOrderPartySizeIntoReservationDraft(
  conversationId: string
): Promise<number | null> {
  const row = await prisma.conversation_state.findFirst({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  const meta = normalizeMetadata(row?.metadata);

  const fromOrder = getRequestedPartySize(meta);
  if (fromOrder == null || !Number.isInteger(fromOrder) || fromOrder < 1) return null;
  if (meta.reservation_draft?.partySize != null) return null;

  await patchReservationDraft(conversationId, { partySize: fromOrder });
  return fromOrder;
}
