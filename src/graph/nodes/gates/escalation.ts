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
 * `is_human_handled` + evento de socket al admin) a través de
 * `humanHandover.service`, para no duplicar el significado de "escalado a
 * humano" en varios lugares.
 */

import { SUPPORT_MESSAGE, handOverToHuman } from '../../../services/humanHandover.service';
import { ConversationIntent } from '../../../types/conversationIntent';
import { textResponse } from '../../../controllers/webhook/utils';
import type { AgentState, AgentStateUpdate } from '../../state';

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

  await handOverToHuman({
    conversationId,
    businessId: state.business?.id,
    customer: state.customer,
    reason: isSupportButton ? 'escalation_gate:support_button' : 'escalation_gate:text_pattern',
  });

  return {
    handlerResult: textResponse(SUPPORT_MESSAGE),
    isHumanHandover: true,
  };
};
