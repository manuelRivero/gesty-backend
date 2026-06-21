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
  updateConversationSentiment,
} from '../../../repositories';
import { isDryRunWhatsAppSend } from '../../../config/env';
import { humanizeHandlerResult } from '../../../services/ai/humanizeBotBody.service';
import { resolvePersonalityPromptText } from '../../../services/botPersonality.service';
import { analyzeConversationSentiment } from '../../../services/ai/conversationSentiment.service';
import { emitAdminConversationSentimentUpdated } from '../../../socket/adminSocket';
import { NEGATIVE_SENTIMENTS } from '../../../types/conversationSentiment';
import type { HandlerResult } from '../../../controllers/webhook/types';
import type { AgentState, AgentStateUpdate } from '../../state';

/**
 * Elimina botones y filas de lista con payload ADD_ITEM del handlerResult.
 * Se aplica cuando el negocio está cerrado y `orders_when_closed=false`.
 */
function stripCartActions(result: HandlerResult): HandlerResult {
  const content = result.content;

  const filteredContent = (() => {
    if (typeof content !== 'object' || content === null) return content;
    const c = content as Record<string, unknown>;

    if (c['type'] === 'interactive') {
      const interactive = c['interactive'] as Record<string, unknown> | undefined;
      const action = interactive?.['action'] as Record<string, unknown> | undefined;
      const buttons = action?.['buttons'] as Array<{ type: string; reply: { id: string; title: string } }> | undefined;
      if (!buttons) return content;
      const filtered = buttons.filter((b) => !b.reply.id.startsWith('ADD_ITEM:'));
      if (filtered.length === buttons.length) return content;
      if (filtered.length === 0) {
        return (interactive?.['body'] as Record<string, unknown>)?.['text'] as string ?? content;
      }
      return { ...c, interactive: { ...interactive, action: { ...action, buttons: filtered } } };
    }

    if (c['type'] === 'list') {
      const action = c['action'] as Record<string, unknown> | undefined;
      const sections = action?.['sections'] as Array<{ title: string; rows: Array<{ id: string }> }> | undefined;
      if (!sections) return content;
      const filteredSections = sections
        .map((s) => ({ ...s, rows: s.rows.filter((r) => !r.id.startsWith('ADD_ITEM:')) }))
        .filter((s) => s.rows.length > 0);
      if (filteredSections.length === sections.length) return content;
      return { ...c, action: { ...action, sections: filteredSections } };
    }

    return content;
  })();

  const filteredFollowUps = result.followUps?.map((fu) => {
    if (fu.type !== 'list') return fu;
    const sections = fu.listMessage.action.sections
      .map((s) => ({ ...s, rows: s.rows.filter((r) => !r.id.startsWith('ADD_ITEM:')) }))
      .filter((s) => s.rows.length > 0);
    return { ...fu, listMessage: { ...fu.listMessage, action: { ...fu.listMessage.action, sections } } };
  });

  const isNowText = typeof filteredContent === 'string';
  return {
    ...result,
    content: filteredContent as HandlerResult['content'],
    isInteractive: isNowText ? false : result.isInteractive,
    followUps: filteredFollowUps,
  };
}

export const sendResponseNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext;
  const result = state.handlerResult;

  if (!ctx || !result) {
    return {};
  }

  const shouldStripCart =
    state.businessClosedButOperating && !state.businessConfig?.orders_when_closed;
  const baseResult = shouldStripCart ? stripCartActions(result) : result;

  const businessId = state.business?.id ?? null;
  const personalityPromptText =
    state.businessConfig?.humanize_messages === true && businessId
      ? await resolvePersonalityPromptText(state.businessConfig.bot_personality_id)
      : undefined;

  const humanizedResult = await humanizeHandlerResult(baseResult, {
    enabled: state.businessConfig?.humanize_messages === true,
    intent: state.resolvedIntent ?? state.detection?.intent ?? null,
    personalityPromptText,
  });

  if (isDryRunWhatsAppSend()) {
    console.log('[dry-run] sendResponseNode skipped', {
      to: ctx.to,
      isInteractive: humanizedResult.isInteractive,
      followUps: humanizedResult.followUps?.length ?? 0,
      humanizeMessages: state.businessConfig?.humanize_messages === true,
    });
    return { handlerResult: humanizedResult };
  }

  await sendResponse(ctx, humanizedResult);
  return { handlerResult: humanizedResult };
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

  for (const followUp of result.followUps ?? []) {
    if (followUp.type === 'text' && followUp.message) {
      await createConversationMessage(conversationId, 'ai', followUp.message, false);
    }
  }

  await updateConversationLastMessageAt(conversationId);

  // Análisis de sentimiento en background: no bloquea el flujo principal.
  // Emite evento Socket.IO si el sentiment nuevo es negativo (alerta)
  // o si el anterior era negativo y ahora ya no lo es (resolución de alerta).
  const conversation = state.conversation;
  const businessId = state.business?.id;
  if (conversation && businessId) {
    const previousSentiment = conversation.ai_sentiment as import('../../../types/conversationSentiment').ConversationSentiment | null;
    void analyzeConversationSentiment(conversationId, conversation.started_at)
      .then(async (result) => {
        if (!result) return;
        await updateConversationSentiment(conversationId, result.sentiment);

        const isNewNegative = NEGATIVE_SENTIMENTS.includes(result.sentiment);
        const wasPreviousNegative = previousSentiment !== null && NEGATIVE_SENTIMENTS.includes(previousSentiment);

        if (isNewNegative || wasPreviousNegative) {
          emitAdminConversationSentimentUpdated(businessId, {
            conversationId,
            sentiment: result.sentiment,
            summary: result.summary,
          });
        }
      })
      .catch((err) => {
        console.error('[Sentiment] Error analizando sentimiento:', err);
      });
  }

  return {};
};
