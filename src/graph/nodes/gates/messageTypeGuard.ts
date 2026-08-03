/**
 * Nodo del grafo principal que valida el tipo de mensaje entrante.
 *
 * El agente solamente procesa:
 * - Mensajes de texto (`text`).
 * - Respuestas a templates / botones interactivos de WhatsApp
 *   (`interactive` con `button_reply` / `list_reply`, y `button` de templates
 *   con Quick Reply).
 * - Ubicación (`location`) únicamente cuando el cliente está dentro del flujo
 *   de onboarding / captura de dirección, o de una sesión de checkout/onboarding
 *   agéntico activa (`checkout_active`/`onboarding_agent_active`, H-08: pedir
 *   la dirección en checkout y rechazar la ubicación compartida por WhatsApp,
 *   el formato más natural de responder, era fricción exactamente en el paso
 *   de conversión). Fuera de esos contextos, la ubicación —incluida la
 *   ubicación en tiempo real— se rechaza.
 * - Imagen (`image`) únicamente cuando el cliente tiene una orden reciente con
 *   `payment_method='transfer'` y `payment_status='unpaid'` (D1, ver
 *   PLAN-ACCION-COMPROBANTES-TRANSFERENCIA.md): es un Fact del dominio, no un
 *   flag de sesión — sobrevive al cierre de la conversación y a esperas de
 *   horas/días. Fuera de ese contexto, la imagen se rechaza igual que
 *   cualquier otro adjunto.
 *
 * Para cualquier otro tipo (audio, video, contactos, documentos, stickers,
 * reacciones, o imagen sin orden pendiente, etc.) se devuelve un
 * `HandlerResult` interactivo con un mensaje amable invitando a escribir la
 * consulta y un único reply button que permite al usuario pedir ayuda
 * (payload `SUPPORT`). El motivo por el que existe el botón —p. ej. clientes
 * que no pueden escribir— se omite intencionalmente del cuerpo del mensaje.
 */

import { findOrCreateConversationState } from '../../../repositories';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import { findOrderAwaitingTransferProof } from '../../../services/payment/transferProof.service';
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
  return (
    Boolean(meta.onboarding_step) ||
    Boolean(meta.awaiting_address) ||
    Boolean(meta.checkout_active) ||
    Boolean(meta.onboarding_agent_active)
  );
};

/**
 * ¿Este cliente tiene una orden reciente de transferencia sin cobrar (D1)?
 * Defensivo: cualquier error se loguea y se trata como "no" — nunca abre el
 * guard por una falla de infraestructura.
 */
const isAwaitingTransferProof = async (
  state: AgentState
): ReturnType<typeof findOrderAwaitingTransferProof> => {
  const business = state.business;
  const customer = state.customer;
  if (!business || !customer) return null;

  try {
    return await findOrderAwaitingTransferProof({
      businessId: business.id,
      customerId: customer.id,
    });
  } catch (error) {
    console.error(
      '[MessageTypeGuard] Error checking awaiting transfer proof order',
      error
    );
    return null;
  }
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

  if (type === 'image') {
    const awaitingTransferProofOrder = await isAwaitingTransferProof(state);
    if (awaitingTransferProofOrder) {
      return { awaitingTransferProofOrder };
    }
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
