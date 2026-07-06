/**
 * Historial conversacional compartido para los agentes ReAct.
 *
 * Todos los agentes (`reactAgent`, `checkoutAgent`, `onboardingAgent`,
 * `reservationAgent`) se invocaban con un único `HumanMessage` que contenía el
 * estado + el mensaje actual, SIN historial de turnos previos. Eso dejaba al
 * agente sin memoria del turno anterior: p.ej. preguntaba "¿querés saber más?"
 * y ante un "Sí" del cliente respondía un saludo genérico porque no sabía qué
 * había preguntado.
 *
 * Este helper reconstruye los turnos previos de la sesión como mensajes con el
 * rol correcto (`HumanMessage` para el cliente, `AIMessage` para el bot) para
 * prependerlos a los inputs del agente y darles el mismo contexto exacto.
 *
 * IMPORTANTE: el mensaje entrante del turno actual YA está persistido como
 * 'user' (nodo `persistUserMessageNode`, previo a todos los agentes), por lo
 * que se excluye por `externalMessageId` para no duplicarlo — el mensaje actual
 * lo aporta el `contextMessage` que arma cada agente al final de los inputs.
 */

import { AIMessage, BaseMessage, HumanMessage } from '@langchain/core/messages';
import { findRecentMessagesForDetectionContext } from '../repositories';

/** Cantidad de mensajes previos a incluir como memoria del agente. */
export const DEFAULT_AGENT_HISTORY_LIMIT = 12;

export interface AgentHistoryParams {
  conversationId: string;
  /** Inicio de sesión; acota el historial a la conversación abierta. */
  startedAt?: Date | null;
  /** `message.id` del turno actual (ya persistido como 'user'); se excluye. */
  currentMessageId?: string | null;
  /** Máximo de mensajes previos. Default {@link DEFAULT_AGENT_HISTORY_LIMIT}. */
  limit?: number;
}

/**
 * Devuelve los turnos previos de la conversación como `BaseMessage[]` en orden
 * cronológico (más viejo → más nuevo), listos para prependerse a los inputs del
 * agente. Nunca lanza: ante cualquier error devuelve `[]` para no romper el
 * turno (el agente sigue funcionando, sólo sin memoria).
 */
export const buildAgentHistoryMessages = async (
  params: AgentHistoryParams
): Promise<BaseMessage[]> => {
  const {
    conversationId,
    startedAt,
    currentMessageId,
    limit = DEFAULT_AGENT_HISTORY_LIMIT,
  } = params;

  if (!conversationId || limit <= 0) return [];

  try {
    // Traemos limit+1 porque el turno actual está persistido y lo descartamos.
    const rows = await findRecentMessagesForDetectionContext(
      conversationId,
      startedAt ?? new Date(0),
      limit + 1
    );

    // `findRecentMessagesForDetectionContext` devuelve desc (más nuevo primero);
    // invertimos a orden cronológico para el LLM.
    const chronological = [...rows].reverse();

    const withoutCurrent = currentMessageId
      ? chronological.filter((m) => m.externalMessageId !== currentMessageId)
      : chronological;

    // Nos quedamos con los `limit` más recientes tras excluir el turno actual.
    const windowed = withoutCurrent.slice(-limit);

    return windowed.reduce<BaseMessage[]>((acc, m) => {
      const content = (m.message ?? '').trim();
      if (!content) return acc;
      acc.push(
        m.sender === 'ai' ? new AIMessage(content) : new HumanMessage(content)
      );
      return acc;
    }, []);
  } catch (err) {
    console.error('[agent-history] failed to build history messages:', err);
    return [];
  }
};
