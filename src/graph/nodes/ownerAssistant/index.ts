/**
 * Nodo del owner_assistant.
 *
 * Sin payloads, sin UI, sin delegación: el dueño no comparte canal con el
 * híbrido de clientes. Secciones 1–3 y 5–8 del factory no aplican.
 */

import { textResponse } from '../../../controllers/webhook/utils/index';
import { runOwnerAssistantAgent } from '../../../agents/ownerAssistantAgent';
import { formatBotUserMessage } from '../../../services/productQuery/utils';
import { buildOwnerAmbiguityFallbackBody } from '../../../services/ownerAssistant/ownerShortcuts.service';
import type { EnrichedContext } from '../../../controllers/webhook/types';
import type { AgentState, AgentStateUpdate } from '../../state';

const ownerErrorFallback = () =>
  formatBotUserMessage('Tu local', '📊', buildOwnerAmbiguityFallbackBody());

export const ownerAssistantAgentNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const conversationId = state.conversation?.id ?? state.conversationId;
  const enrichedBase = state.enrichedCtx as unknown as EnrichedContext;

  let agentResult: Awaited<ReturnType<typeof runOwnerAssistantAgent>>;
  try {
    agentResult = await runOwnerAssistantAgent(enrichedBase);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: '[owner-assistant] invoke_error',
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      })
    );
    agentResult = null;
  }

  if (!agentResult) {
    console.log(
      JSON.stringify({
        event: '[owner-assistant] empty_result_fallback',
        conversationId,
      })
    );
    return {
      handlerResult: textResponse(ownerErrorFallback()),
      dataCollectionDelegated: true,
    };
  }

  return {
    handlerResult: textResponse(agentResult.text),
    dataCollectionDelegated: true,
  };
};
