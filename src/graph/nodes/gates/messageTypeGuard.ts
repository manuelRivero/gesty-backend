/**
 * Nodo del grafo principal que valida el tipo de mensaje entrante.
 *
 * El agente solamente procesa:
 * - Mensajes de texto (`text`).
 * - Respuestas a templates / botones interactivos de WhatsApp
 *   (`interactive` con `button_reply` / `list_reply`, y `button` de templates
 *   con Quick Reply).
 * - Ubicación (`location`) únicamente cuando el cliente está dentro del flujo
 *   de onboarding / captura de dirección (necesario para que el
 *   `AddressService` pueda registrar la ubicación compartida). Fuera de ese
 *   contexto, la ubicación —incluida la ubicación en tiempo real— se rechaza.
 *
 * Para cualquier otro tipo (imagen, audio, video, contactos, documentos,
 * stickers, reacciones, etc.) se devuelve un `HandlerResult` interactivo con
 * un mensaje amable invitando a escribir la consulta y un único reply button
 * que permite al usuario pedir ayuda (payload `SUPPORT`). El motivo por el que
 * existe el botón —p. ej. clientes que no pueden escribir— se omite
 * intencionalmente del cuerpo del mensaje.
 */

import { findOrCreateConversationState } from '../../../repositories';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import type { WhatsAppInteractiveMessage } from '../../../domain/intent/whatsappTemplates';
import type { AgentState, AgentStateUpdate } from '../../state';

/** Tipos aceptados sin condiciones adicionales. */
const ALLOWED_MESSAGE_TYPES = new Set<string>(['text', 'interactive', 'button']);

const UNSUPPORTED_MESSAGE_BODY =
  '🤖\n\n*No puedo procesar este tipo de mensaje* 🙏\n\nPor favor, escribime tu consulta en un mensaje de texto y con gusto te ayudo. ✍️';

const SUPPORT_BUTTON_TITLE = 'Pedir ayuda';

const buildUnsupportedMessageReply = (): WhatsAppInteractiveMessage => ({
  type: 'interactive',
  interactive: {
    type: 'button',
    header: { type: 'text', text: '' },
    body: { text: UNSUPPORTED_MESSAGE_BODY },
    footer: { text: '' },
    action: {
      buttons: [
        {
          type: 'reply',
          reply: {
            id: ConversationIntent.SUPPORT,
            title: SUPPORT_BUTTON_TITLE,
          },
        },
      ],
    },
  },
});

/**
 * Determina si el cliente está actualmente dentro de un flujo donde compartir
 * la ubicación tiene sentido (onboarding activo o `awaiting_address`).
 */
const isWithinAddressCaptureFlow = async (
  state: AgentState
): Promise<boolean> => {
  const cached = state.workingConversationState ?? state.conversationState;
  let conversationState = cached;
  if (!conversationState && state.conversationId) {
    try {
      conversationState = await findOrCreateConversationState(state.conversationId);
    } catch (error) {
      console.error(
        '[MessageTypeGuard] Error fetching conversation_state',
        error
      );
      return false;
    }
  }
  if (!conversationState) return false;

  const meta = normalizeMetadata(conversationState.metadata);
  return Boolean(meta.onboarding_step) || Boolean(meta.awaiting_address);
};

export const messageTypeGuardNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const message = state.webhookContext?.message;
  const type: string | undefined =
    message && typeof message.type === 'string' ? message.type : undefined;

  if (!type) {
    return {};
  }

  if (ALLOWED_MESSAGE_TYPES.has(type)) {
    return {};
  }

  if (type === 'location' && (await isWithinAddressCaptureFlow(state))) {
    return {};
  }

  console.log('[MessageTypeGuard] Unsupported message type, replying with notice:', {
    type,
    payloadId: state.webhookContext?.payloadId,
    conversationId: state.conversationId,
  });

  return {
    handlerResult: {
      content: buildUnsupportedMessageReply(),
      isInteractive: true,
    },
    earlyExit: 'unsupported_message_type',
  };
};
