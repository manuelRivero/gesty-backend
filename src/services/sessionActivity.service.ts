/**
 * Punto único de actividad de sesión.
 *
 * `touchSession` es el único punto autorizado para renovar los timeouts de
 * `conversation` (idle) y `draft_order` (expiración de carrito). Ningún nodo
 * de grafo, tool o handler debe llamar directamente a
 * `refreshDraftOrderTimeout`, `updateConversationLastMessageAt` o
 * `clearConversationIdleTimestamps` para representar actividad del usuario —
 * esas funciones quedan como detalle de implementación interno de este
 * servicio (la única excepción legítima es la inicialización de un
 * `draft_order` recién creado, que fija su primer `expires_at` en el mismo
 * lugar donde nace la fila, no en `touchSession`).
 *
 * Invariante: toda actividad iniciada por el usuario que llegue al grafo
 * ejecuta exactamente una llamada a `touchSession` (en `persistUserMessageNode`,
 * `src/graph/nodes/context/index.ts`), antes de que cualquier agente o nodo de
 * negocio procese el evento.
 *
 * La selección de qué draft renovar vive acá, no en el nodo que llama a esta
 * función: el nodo solo expresa "hubo un evento entrante de este cliente, en
 * esta conversación, en este negocio" con IDs primitivos — desconoce que
 * existe un concepto de "draft activo" o cómo se busca.
 */

import { prisma } from '../lib/prisma';
import {
  clearConversationIdleTimestamps,
  updateConversationLastMessageAt,
} from '../repositories/conversation.repository';
import { refreshDraftOrderTimeout } from './draftOrderTimeout.service';

export interface TouchSessionParams {
  conversationId: string;
  businessId: string;
  customerPhone: string;
}

/**
 * Registra un evento entrante del usuario como actividad de sesión: renueva
 * el idle-timeout de la conversación y, si existe un `draft_order` activo
 * para ese cliente, también su `expires_at`.
 */
export const touchSession = async (params: TouchSessionParams): Promise<void> => {
  await clearConversationIdleTimestamps(params.conversationId);
  await updateConversationLastMessageAt(params.conversationId);

  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: params.businessId,
      customer_phone: params.customerPhone,
      status: 'active',
    },
    select: { id: true },
  });
  if (draft) {
    await refreshDraftOrderTimeout(draft.id);
  }
};
