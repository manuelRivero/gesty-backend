import { updateCustomerName } from '../../../repositories';
import { patchConversationMetadata } from '../../../repositories/conversationState.repository';
import { NAME_COLLECTION_PROMPT_MESSAGE } from '../../../services/nameCollectionGate.service';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import type { HandlerFollowUp } from '../../../controllers/webhook/types';
import type { AgentState, AgentStateUpdate } from '../../state';

/**
 * Nodo post-handler que gestiona la captura del nombre del cliente.
 *
 * - Si la detección extrajo `customerName` y el cliente aún no tiene nombre,
 *   persiste en DB y limpia el flag `awaiting_name`.
 * - Si el cliente no tiene nombre y nunca se lo pedimos, inyecta el pedido como
 *   follow-up de texto (mensaje WhatsApp separado) y activa `awaiting_name`.
 * - Si `skipAIPersistence` está activo (negocio cerrado, etc.) pasa de largo.
 * - Es el único punto de escritura de `customer.name` en el flujo.
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
    return {};
  }

  const detection = state.detection;
  const conversation = state.conversation!;

  // 1) Persistir nombre si el detector lo extrajo (con o sin intent PROVIDE_NAME)
  const extractedName = detection?.customerName?.trim();
  if (extractedName) {
    await updateCustomerName(customer.id, extractedName);
    if (meta.awaiting_name) {
      await patchConversationMetadata(conversation.id, { awaiting_name: false });
    }
    return { customer: { ...customer, name: extractedName } };
  }

  // 2) Pedir el nombre como follow-up (solo una vez, solo si hay respuesta principal)
  if (!meta.awaiting_name && state.handlerResult) {
    await patchConversationMetadata(conversation.id, { awaiting_name: true });
    const ask: HandlerFollowUp = {
      type: 'text',
      message: NAME_COLLECTION_PROMPT_MESSAGE,
    };
    return {
      handlerResult: {
        ...state.handlerResult,
        followUps: [...(state.handlerResult.followUps ?? []), ask],
      },
    };
  }

  return {};
};
