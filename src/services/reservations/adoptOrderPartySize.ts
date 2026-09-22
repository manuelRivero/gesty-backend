/**
 * Adopción de personas del pedido al abrir la mesa (cambio de dominio).
 *
 * "Somos 6" es el mismo Fact en los dos dominios: si el híbrido eligió la
 * puerta de pedido y guardó el número ahí, al abrir la reserva se adopta en el
 * draft en vez de tirarlo. Es lo que hace que una elección de dominio errada no
 * le cueste nada al cliente — no repite el dato.
 *
 * Solo completa un hueco: si el draft ya tiene `partySize`, gana el draft.
 * Un número arrastrado de un pedido anterior de la misma conversación es visible
 * para el cliente en la tarjeta de confirmación antes de crear la reserva, así
 * que la adopción no puede cerrar una reserva con un dato que no vio.
 */

import { readReservationDraft, patchReservationDraft } from './draft.repository';
import { getRequestedPartySize } from '../productQuery/utils';
import type { ConversationMetadata } from '../productQuery/types';

export async function adoptOrderPartySizeIntoReservationDraft(params: {
  conversationId: string;
  metadata: ConversationMetadata;
}): Promise<number | null> {
  const fromOrder = getRequestedPartySize(params.metadata);
  if (fromOrder == null || !Number.isInteger(fromOrder) || fromOrder < 1) return null;

  const draft = await readReservationDraft(params.conversationId);
  if (draft.partySize != null) return null;

  await patchReservationDraft(params.conversationId, { partySize: fromOrder });
  return fromOrder;
}
