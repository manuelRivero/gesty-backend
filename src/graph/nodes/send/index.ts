/**
 * Nodos de salida del grafo principal.
 *
 * - `sendResponseNode`: envía a la WhatsApp Cloud API el `HandlerResult`
 *   producido por handlers/gates/dispatch (texto + interactive + followUps).
 * - `persistAIMessageNode`: persiste la respuesta del bot en
 *   `conversation_message` y refresca `last_message_at`.
 *
 * Se invocan en cadena al final de cualquier rama que produzca `handlerResult`.
 */

import { sendResponse } from '../../../controllers/webhook/sender';
import {
  createConversationMessage,
  updateConversationLastMessageAt,
} from '../../../repositories';
import { isDryRunWhatsAppSend } from '../../../config/env';
import type { AgentState, AgentStateUpdate } from '../../state';

export const sendResponseNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext;
  const result = state.handlerResult;

  if (!ctx || !result) {
    return {};
  }

  if (isDryRunWhatsAppSend()) {
    console.log('[dry-run] sendResponseNode skipped', {
      to: ctx.to,
      isInteractive: result.isInteractive,
      followUps: result.followUps?.length ?? 0,
    });
    return {};
  }

  await sendResponse(ctx, result);
  return {};
};

export const persistAIMessageNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const result = state.handlerResult;
  if (!result) {
    return {};
  }

  const conversationId =
    state.conversationId ??
    state.conversation?.id ??
    null;

  if (!conversationId) {
    return {};
  }

  if (isDryRunWhatsAppSend()) {
    console.log('[dry-run] persistAIMessageNode skipped', {
      conversationId,
    });
    return {};
  }

  const aiContent =
    typeof result.content === 'string' ? result.content : '[interactive]';

  await createConversationMessage(conversationId, 'ai', aiContent, true);
  await updateConversationLastMessageAt(conversationId);

  return {};
};
