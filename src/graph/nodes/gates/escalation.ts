/**
 * Detector determinista de escalamiento a humano (V-02, ADR-0002).
 *
 * No es un Goal ni una Alert: es un interrupt. Un cliente que pide hablar
 * con una persona no puede depender de que el LLM, en medio de una sesión
 * de checkout/reserva/onboarding, decida delegar — dentro de esas sesiones
 * el turno normalmente nunca llega al dispatcher determinístico. Este nodo
 * corre en TODO turno, antes de que Ownership decida quién habla, sin
 * excepción de sesión.
 *
 * Reutiliza la semántica de `SupportHandler` (mismo mensaje, mismo efecto:
 * `is_human_handled` + evento de socket al admin) para no duplicar el
 * significado de "escalado a humano" en dos lugares.
 */

import {
  findOrCreateConversationState,
  updateConversationState,
} from '../../../repositories/conversationState.repository';
import { emitAdminWhatsappSupportRequested } from '../../../socket/adminSocket';
import { ConversationIntent } from '../../../types/conversationIntent';
import { textResponse } from '../../../controllers/webhook/utils';
import type { AgentState, AgentStateUpdate } from '../../state';

const SUPPORT_MESSAGE =
  '🤖\n\n*Tu consulta fue derivada a nuestro equipo* 🎧\n\n' +
  'En breve, uno de nuestros asesores te atenderá con mucho gusto y resolverá todas tus dudas.\n\n' +
  'Espero poder acompañarte de nuevo en una próxima oportunidad. ¡Hasta pronto! 👋';

/**
 * Frases inequívocas de pedido de un humano. Deliberadamente conservador:
 * exige un verbo de contacto junto a un sustantivo de persona/soporte para
 * no disparar con "somos 4 personas" o "atención" sueltos en otro contexto.
 */
const ESCALATION_PATTERNS: RegExp[] = [
  /\b(hablar|comunicar|conectar|pasar|atiend[ae]|derivar)\w*\s+(me\s+)?con\s+(un|una|el|la)?\s*(humano|persona|agente|operador[a]?|representante|empleado[a]?|alguien\s+real)/i,
  /\bquiero\s+(hablar\s+con\s+)?(un|una)\s+(humano|agente|operador[a]?|representante)\b/i,
  /\b(no\s+quiero\s+(hablar|seguir)\s+con\s+(un|una)?\s*(bot|robot))\b/i,
  /\bd[ae]me\s+con\s+(un|una)?\s*(humano|persona|agente|operador[a]?)\b/i,
  /\batenci[oó]n\s+humana\b/i,
  /\bsos\s+un\s+bot\b.*\b(humano|persona)\b/i,
];

const matchesEscalation = (text: string | undefined): boolean => {
  if (!text || text.trim().length === 0) return false;
  return ESCALATION_PATTERNS.some((pattern) => pattern.test(text));
};

export const escalationGateNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const message = state.webhookContext?.message;
  const messageType: string | undefined =
    message && typeof message.type === 'string' ? message.type : undefined;
  const payloadId = state.webhookContext?.payloadId;

  const isSupportButton = payloadId === ConversationIntent.SUPPORT;
  const isEscalationText =
    messageType === 'text' && matchesEscalation(message?.text?.body);

  if (!isSupportButton && !isEscalationText) {
    return {};
  }

  const conversationId = state.conversationId;
  if (!conversationId) return {};

  try {
    // Garantiza la fila antes de actualizarla: en este punto del pipeline
    // (antes de `buildDetectionContextNode`) todavía puede no existir.
    await findOrCreateConversationState(conversationId);
    await updateConversationState(conversationId, { is_human_handled: true });
    console.log('[EscalationGate] Conversation handed over to human (deterministic):', {
      conversationId,
      trigger: isSupportButton ? 'support_button' : 'text_pattern',
    });
    const businessId = state.business?.id;
    if (typeof businessId === 'string' && businessId.length > 0) {
      const customer = state.customer as
        | { id?: string; phone_number?: string | null; name?: string | null }
        | null;
      emitAdminWhatsappSupportRequested(businessId, {
        conversationId,
        customerId: typeof customer?.id === 'string' ? customer.id : null,
        customerPhone:
          typeof customer?.phone_number === 'string' ? customer.phone_number : null,
        customerName: typeof customer?.name === 'string' ? customer.name : null,
      });
    }
  } catch (error) {
    console.error('[EscalationGate] Failed to set is_human_handled:', error);
  }

  return {
    handlerResult: textResponse(SUPPORT_MESSAGE),
    isHumanHandover: true,
  };
};
