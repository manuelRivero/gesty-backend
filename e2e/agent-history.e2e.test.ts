/**
 * E2E: historial conversacional inyectado a los agentes ReAct.
 *
 * Prueba `buildAgentHistoryMessages` contra BD + grafo reales (el unit test
 * mockea el repo; esto verifica que el helper lee filas Prisma reales con los
 * `sender` / `externalMessageId` que persiste `persistUserMessageNode`).
 *
 * Regresión guardada: antes los agentes se invocaban con un único HumanMessage
 * sin memoria del turno anterior (p.ej. bot pregunta → cliente "Sí" → saludo
 * genérico). Ver src/agents/conversationHistory.ts.
 *
 * Aserciones sobre estructura/efectos (no copy del LLM); ver e2e/README.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { applyE2eEnv, e2eSkipReason, isE2eEnabled } from './helpers/env';
import {
  buildTextPayload,
  disconnectPrisma,
  hasHandlerResponse,
  loadMainGraph,
  resetE2eCustomer,
  runGraphTurn,
  type MainGraph,
} from './helpers/graphHarness';
import type { WhatsAppWebhookPayload } from '../src/controllers/webhook/types';
import { buildAgentHistoryMessages } from '../src/agents/conversationHistory';

/** Lee el `message.id` que el harness embebe en el payload entrante. */
const incomingMessageId = (payload: WhatsAppWebhookPayload): string =>
  payload.entry[0].changes[0].value.messages?.[0]?.id ?? '';

/** `started_at` real de la conversación (acota el historial a la sesión abierta). */
const conversationStartedAt = async (
  conversationId: string
): Promise<Date | null> => {
  const { prisma } = await import('../src/lib/prisma');
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { started_at: true },
  });
  return row?.started_at ?? null;
};

describe.sequential.skipIf(!isE2eEnabled())('agent history (e2e)', () => {
  let graph: MainGraph;
  let conversationId: string;

  beforeAll(async () => {
    applyE2eEnv();
    graph = await loadMainGraph();
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
  }, 60_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('reconstruye el turno previo del cliente y excluye el turno actual', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    // Nota: bajo e2e (`DRY_RUN_WHATSAPP_SEND=true`) `persistAIMessageNode` se
    // salta, así que la respuesta del bot NO queda en BD; el historial sólo
    // contiene mensajes 'user'. En producción sí se persiste el 'ai' y entra al
    // historial. Por eso acá probamos memoria con dos turnos del cliente.
    const t1 = buildTextPayload('¿Tienen ceviche?');
    const s1 = await runGraphTurn(graph, t1);
    expect(hasHandlerResponse(s1.handlerResult)).toBe(true);

    const t2 = buildTextPayload('¿Y tienen tiradito?');
    const t2Id = incomingMessageId(t2);
    const s2 = await runGraphTurn(graph, t2);
    expect(hasHandlerResponse(s2.handlerResult)).toBe(true);

    const startedAt = await conversationStartedAt(conversationId);

    // Sin excluir: el historial trae ambos turnos del cliente en orden
    // cronológico (el previo "ceviche" antes del actual "tiradito").
    const history = await buildAgentHistoryMessages({
      conversationId,
      startedAt,
      currentMessageId: null,
    });
    expect(history.every((m) => m instanceof HumanMessage)).toBe(true);
    const cevicheIdx = history.findIndex((m) =>
      String(m.content).includes('ceviche')
    );
    const tiraditoIdx = history.findIndex((m) =>
      String(m.content).includes('tiradito')
    );
    expect(cevicheIdx).toBeGreaterThanOrEqual(0);
    expect(tiraditoIdx).toBeGreaterThanOrEqual(0);
    expect(cevicheIdx).toBeLessThan(tiraditoIdx); // cronológico: previo → actual

    // Excluir el turno actual por su `externalMessageId` lo quita del historial
    // (así el agente no lo ve duplicado: va sólo en el contextMessage), pero
    // conserva la memoria del turno previo.
    const withoutCurrent = await buildAgentHistoryMessages({
      conversationId,
      startedAt,
      currentMessageId: t2Id,
    });
    expect(
      withoutCurrent.some((m) => String(m.content).includes('ceviche'))
    ).toBe(true);
    expect(
      withoutCurrent.some((m) => String(m.content).includes('tiradito'))
    ).toBe(false);
  }, 240_000);

  it('tras establecer contexto, una confirmación escueta ("Sí") produce respuesta', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    // Turno 1: establece tema.
    const s1 = await runGraphTurn(graph, buildTextPayload('¿Tienen ceviche?'));
    expect(hasHandlerResponse(s1.handlerResult)).toBe(true);

    // Turno 2: confirmación breve. Con historial cableado el agente responde
    // (no debe romper por los mensajes prependidos ni quedar mudo).
    const s2 = await runGraphTurn(
      graph,
      buildTextPayload('Sí, contame más')
    );
    expect(hasHandlerResponse(s2.handlerResult)).toBe(true);
  }, 240_000);
});

describe('agent history (e2e) — skip info', () => {
  it('documenta requisitos si e2e está deshabilitado', () => {
    if (isE2eEnabled()) return;
    expect(e2eSkipReason()).toBeTruthy();
  });
});
