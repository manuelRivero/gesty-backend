import { updateCustomerName } from '../../../repositories';
import { patchConversationMetadata } from '../../../repositories/conversationState.repository';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import type { AgentState, AgentStateUpdate } from '../../state';

/**
 * Nodo post-handler que persiste el nombre del cliente cuando la detección NLP
 * lo extrajo de forma espontánea (ej.: "soy Juan").
 *
 * IMPORTANTE: este nodo NO pide el nombre de forma proactiva. Tras el refactor
 * a React agents, la recolección del nombre es responsabilidad EXCLUSIVA del
 * `checkoutAgent` (tool `save_customer_name`, paso obligatorio antes de pagar)
 * y del `reservationAgent` (`ASK_NAME_FINAL`, antes de confirmar). Pedirlo acá
 * disparaba el mensaje en momentos arbitrarios (ej.: al ver el detalle de un
 * producto), por lo que se removió ese comportamiento.
 *
 * - Si la detección extrajo `customerName` y el cliente aún no tiene nombre,
 *   persiste en DB y limpia el flag `awaiting_name` si estuviera activo.
 * - Si `skipAIPersistence` está activo (negocio cerrado, etc.) pasa de largo.
 */
export const nameCollectionNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const customer = state.customer!;

  if (state.skipAIPersistence) return {};
  if (state.dataCollectionDelegated) return {};  // agente gestiona nombre via save_customer_name
  if (customer.name) return {};

  const meta = normalizeMetadata(state.workingConversationState?.metadata);
  if (meta.reservation?.step || meta.reservation?.paused) {
    // El nombre en el flujo de reserva lo gestiona el wizard al final (ASK_NAME_FINAL).
    // `meta.reservation` es del wizard @deprecated (ver reservation.service.ts).
    return {};
  }

  const detection = state.detection;
  const conversation = state.conversation!;

  // Persistir nombre solo si el detector lo extrajo (con o sin intent PROVIDE_NAME).
  const extractedName = detection?.customerName?.trim();
  if (extractedName) {
    await updateCustomerName(customer.id, extractedName);
    if (meta.awaiting_name) {
      await patchConversationMetadata(conversation.id, { awaiting_name: false });
    }
    return { customer: { ...customer, name: extractedName } };
  }

  return {};
};
