/**
 * Semántica única de "escalado a humano": marcar `is_human_handled` en la
 * conversación y avisarle al panel del local.
 *
 * Vivía duplicada en `SupportHandler` y en `escalationGateNode` — el propio
 * comentario de `escalation.ts` pedía no duplicar el significado de "escalado
 * a humano" en dos lugares. La Fase 8 de los comprobantes de transferencia
 * necesitaba un tercer llamador, así que se extrajo acá.
 *
 * Efecto aguas abajo: con `is_human_handled` en true, `buildDetectionContextNode`
 * corta el turno (`bot_disabled_or_human_handled`) y el bot deja de responder
 * automáticamente hasta que un admin devuelva la conversación.
 */

import {
  findOrCreateConversationState,
  updateConversationState,
} from '../repositories/conversationState.repository';
import { emitAdminWhatsappSupportRequested } from '../socket/adminSocket';

export const SUPPORT_MESSAGE =
  '🤖\n\n*Tu consulta fue derivada a nuestro equipo* 🎧\n\n' +
  'En breve, uno de nuestros asesores te atenderá con mucho gusto y resolverá todas tus dudas.\n\n' +
  'Espero poder acompañarte de nuevo en una próxima oportunidad. ¡Hasta pronto! 👋';

type HandoverCustomer = {
  id?: string;
  phone_number?: string | null;
  name?: string | null;
} | null | undefined;

/**
 * Nunca lanza: un fallo al escalar se loguea pero no puede tirar el turno del
 * cliente ni el job que lo invoca.
 *
 * @param reason etiqueta corta para el log (quién escaló y por qué).
 */
export async function handOverToHuman(params: {
  conversationId: string;
  businessId?: string | null;
  customer?: HandoverCustomer;
  reason: string;
}): Promise<void> {
  const { conversationId, businessId, customer, reason } = params;

  try {
    // Garantiza la fila antes de actualizarla: según desde dónde se escale,
    // el `conversation_state` puede todavía no existir.
    await findOrCreateConversationState(conversationId);
    await updateConversationState(conversationId, { is_human_handled: true });
    console.log('[HumanHandover] Conversation handed over to human:', {
      conversationId,
      reason,
    });

    if (typeof businessId === 'string' && businessId.length > 0) {
      emitAdminWhatsappSupportRequested(businessId, {
        conversationId,
        customerId: typeof customer?.id === 'string' ? customer.id : null,
        customerPhone:
          typeof customer?.phone_number === 'string' ? customer.phone_number : null,
        customerName: typeof customer?.name === 'string' ? customer.name : null,
      });
    }
  } catch (error) {
    console.error('[HumanHandover] Failed to set is_human_handled:', error);
  }
}
