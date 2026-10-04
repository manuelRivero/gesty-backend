import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HumanIntentPreflightInput } from '../src/services/humanIntentPreflight.service';
import { isE2eEnabled, applyE2eEnv } from './helpers/env';
import {
  buildTextPayload,
  disconnectPrisma,
  extractHandlerText,
  loadMainGraph,
  resetE2eCustomer,
  type MainGraph,
} from './helpers/graphHarness';
import {
  assertLifecycleInvariant,
  compactValue,
  formatHumanIntentTrace,
  snapshotHumanIntentState,
  traceJson,
  type HumanIntentCaseTrace,
  type LifecycleToolCall,
  type LifecycleTurn,
} from './helpers/humanIntentLifecycleTrace';

const preflightObservations = vi.hoisted(() => ({
  entries: [] as Array<{ input: unknown; decision: unknown }>,
}));

vi.mock('../src/services/humanIntentPreflight.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/humanIntentPreflight.service')>();
  return {
    ...actual,
    runHumanIntentPreflight: async (input: HumanIntentPreflightInput) => {
      const decision = await actual.runHumanIntentPreflight(input);
      preflightObservations.entries.push({ input, decision });
      return decision;
    },
  };
});

class ToolTraceCallback extends BaseCallbackHandler {
  name = 'human-intent-lifecycle-trace';
  readonly calls: LifecycleToolCall[] = [];
  private readonly byRunId = new Map<string, LifecycleToolCall>();

  async handleToolStart(
    tool: { name?: string; id?: string[] },
    input: string,
    runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string
  ): Promise<void> {
    let args: unknown = input;
    try {
      args = JSON.parse(input) as unknown;
    } catch {
      // Preserve non-JSON callback input.
    }
    const call: LifecycleToolCall = {
      name: runName ?? tool.name ?? tool.id?.at(-1) ?? 'unknown_tool',
      args,
      result: 'pending',
    };
    this.calls.push(call);
    this.byRunId.set(runId, call);
  }

  async handleToolEnd(output: unknown, runId: string): Promise<void> {
    const call = this.byRunId.get(runId);
    if (!call) return;
    let decoded = output;
    if (typeof decoded === 'string') {
      try {
        decoded = JSON.parse(decoded) as unknown;
      } catch {
        call.result = compactValue(decoded);
        return;
      }
    }
    if (typeof decoded === 'object' && decoded !== null && 'kwargs' in decoded) {
      const kwargs = (decoded as { kwargs?: Record<string, unknown> }).kwargs;
      if (typeof kwargs?.name === 'string') call.name = kwargs.name;
      call.result = compactValue(kwargs?.content ?? decoded);
      return;
    }
    if (typeof decoded === 'object' && decoded !== null && 'content' in decoded) {
      const message = decoded as { content?: unknown; name?: unknown };
      if (typeof message.name === 'string') call.name = message.name;
      call.result = compactValue(message.content ?? decoded);
      return;
    }
    call.result = compactValue(decoded);
  }

  async handleToolError(error: unknown, runId: string): Promise<void> {
    const call = this.byRunId.get(runId);
    if (call) call.result = `ERROR ${compactValue(error)}`;
  }
}

const normalize = (value: unknown): string =>
  String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

const intentText = (intent: { goal: string; request: string[] }): string =>
  normalize([intent.goal, ...intent.request].join(' '));

const hasIntent = (
  state: LifecycleTurn['humanIntentAfter'],
  goal: string,
  target: string
): boolean =>
  [...state.active, ...state.pending].some(
    (intent) => intent.goal === goal && intentText(intent).includes(normalize(target))
  );

const toolMentions = (call: LifecycleToolCall, target: string): boolean =>
  (() => {
    const searchable = normalize(`${call.name} ${JSON.stringify(call.args)} ${call.result}`);
    const aliases: Record<string, string[]> = {
      postres: ['postre', 'dessert', 'dulce'],
      bebidas: ['bebida', 'drink', 'beverage'],
    };
    return [target, ...(aliases[normalize(target)] ?? [])].some((term) =>
      searchable.includes(normalize(term))
    );
  })();

const decisionName = (turn: LifecycleTurn): string | undefined =>
  (turn.preflight as { decision?: { decision?: string } } | null)?.decision?.decision;

const clearPartySize = async (conversationId: string): Promise<void> => {
  const { omitConversationMetadataKeys } = await import('../src/repositories/conversationState.repository');
  await omitConversationMetadataKeys(conversationId, ['peopleCount', 'requestedPartySize']);
};

describe.skipIf(!isE2eEnabled())('HumanIntentState lifecycle E2E', () => {
  let graph: MainGraph;
  let conversationId: string;
  const traces: HumanIntentCaseTrace[] = [];

  beforeAll(async () => {
    applyE2eEnv({ CHECKOUT_AGENT_ENABLED: 'true', HYBRID_CTA_ENABLED: 'true' });
    graph = await loadMainGraph();
  }, 60_000);

  afterAll(async () => {
    if (traces.length > 0) {
      const reportPath = resolve(process.cwd(), 'e2e/.last-human-intent-lifecycle-report.json');
      writeFileSync(reportPath, traceJson(traces), 'utf8');
      console.log(traces.map(formatHumanIntentTrace).join('\n\n'));
      console.log(`HumanIntentState trace JSON: ${reportPath}`);
    }
    await disconnectPrisma();
  });

  const runCase = async (
    caseName: string,
    messages: string[],
    options?: { requirePartySize?: boolean }
  ): Promise<HumanIntentCaseTrace> => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    const { patchConversationMetadata } = await import('../src/repositories/conversationState.repository');
    if (options?.requirePartySize) await clearPartySize(conversationId);
    await patchConversationMetadata(conversationId, {
      humanIntentState: {
        version: 1,
        revision: 0,
        nextSequence: 1,
        processedMessageIds: [],
        records: [],
      },
    });
    preflightObservations.entries.length = 0;

    const trace: HumanIntentCaseTrace = { caseName, status: 'RUNNING', turns: [] };
    traces.push(trace);
    for (let index = 0; index < messages.length; index += 1) {
      const userMessage = messages[index];
      const payload = buildTextPayload(userMessage);
      const messageId = payload.entry[0].changes[0].value.messages?.[0].id ?? '';
      const before = await (await import('../src/services/humanIntentState.service'))
        .getHumanIntentState(conversationId);
      const callback = new ToolTraceCallback();
      const result = await graph.invoke(
        { webhookPayload: payload },
        { callbacks: [callback], runName: `human-intent-turn-${index + 1}` }
      );
      const after = await (await import('../src/services/humanIntentState.service'))
        .getHumanIntentState(conversationId);
      const conversationMetadataAfter = await (await import('./helpers/graphHarness'))
        .getFreshConversationMetadata(conversationId);
      const observation = [...preflightObservations.entries]
        .reverse()
        .find((entry) => (entry.input as HumanIntentPreflightInput).turn.messageId === messageId);
      const preflight = observation ? { decision: observation.decision } : null;
      const turn: LifecycleTurn = {
        turn: index + 1,
        userMessage,
        preflight,
        humanIntentBefore: snapshotHumanIntentState(before),
        humanIntentAfter: snapshotHumanIntentState(after),
        toolCalls: callback.calls,
        assistantResponse: extractHandlerText(result.handlerResult),
        conversationMetadataAfter,
      };
      trace.turns.push(turn);
      assertLifecycleInvariant(
        trace,
        index + 1,
        'INV-1',
        turn.humanIntentAfter.active.length <= 1,
        'máximo un ACTIVE',
        `${turn.humanIntentAfter.active.length} ACTIVE`
      );
      const becameResolved = turn.humanIntentAfter.records.filter((intent) =>
        turn.humanIntentBefore.records.some(
          (previous) => previous.id === intent.id && previous.status !== 'RESOLVED' && intent.status === 'RESOLVED'
        )
      );
      if (becameResolved.length > 0) {
        assertLifecycleInvariant(
          trace,
          index + 1,
          'INV-4',
          becameResolved.every((intent) => intent.outcome?.success === true),
          'outcome.success=true persistido para cada HumanIntent resuelta',
          compactValue(becameResolved)
        );
      }
    }
    return trace;
  };

  it('CASE 01 — Active + Pending', async () => {
    const trace = await runCase('CASE 01 — Active + Pending', [
      'Quiero hacer un pedido',
      'Para 2',
      'Quiero una milanesa y también quiero ver los postres',
      'Quiero la milanesa de pollo',
      '¿Qué postres tienen?',
    ], { requirePartySize: true });
    const turn3 = trace.turns[2];
    assertLifecycleInvariant(trace, 3, 'INV-6', hasIntent(turn3.humanIntentAfter, 'PEDIR', 'milanesa'), 'PEDIR/milanesa permanece vigente', compactValue(turn3.humanIntentAfter));
    assertLifecycleInvariant(trace, 3, 'INV-6', turn3.humanIntentAfter.pending.some((intent) => intent.goal === 'EXPLORAR' && intentText(intent).includes('postres')), 'EXPLORAR/postres en PENDING', compactValue(turn3.humanIntentAfter));
    assertLifecycleInvariant(trace, 3, 'INV-6', !turn3.humanIntentAfter.pending.some((intent) => intent.goal === 'PEDIR'), 'sin una segunda intención PEDIR en PENDING', compactValue(turn3.humanIntentAfter));
    assertLifecycleInvariant(trace, 3, 'INV-2', !turn3.toolCalls.some((call) => toolMentions(call, 'postres')), 'ninguna tool ejecuta postres mientras sigue PENDING', compactValue(turn3.toolCalls));
    assertLifecycleInvariant(trace, 5, 'INV-5', trace.turns[4].humanIntentAfter.active.some((intent) => intent.goal === 'EXPLORAR' && intentText(intent).includes('postres')) || trace.turns[4].humanIntentAfter.records.some((intent) => intent.goal === 'EXPLORAR' && intent.status === 'RESOLVED' && intentText(intent).includes('postres')), 'postres ACTIVE o RESOLVED al solicitarlo', compactValue(trace.turns[4].humanIntentAfter));
    trace.status = 'PASS';
  }, 480_000);

  it('CASE 02 — Party-size blocker conserva la intención', async () => {
    const trace = await runCase('CASE 02 — Party-size blocker', [
      'Quiero una milanesa y una gaseosa',
      'Para 3',
      'Quiero la milanesa',
      'Agregá también la gaseosa',
    ], { requirePartySize: true });
    const orderId = trace.turns[0].humanIntentAfter.active[0]?.id;
    const turn2 = trace.turns[1];
    assertLifecycleInvariant(trace, 2, 'INV-3', Boolean(orderId) && turn2.humanIntentAfter.active.some((intent) => intent.id === orderId), 'mismo intentId PEDIR sigue ACTIVE después del gate', compactValue(turn2.humanIntentAfter));
    assertLifecycleInvariant(trace, 2, 'INV-9', decisionName(turn2) === 'CONTINUE_ACTIVE', 'decisión CONTINUE_ACTIVE', compactValue(turn2.preflight));
    assertLifecycleInvariant(trace, 2, 'INV-4', turn2.humanIntentAfter.active.some((intent) => intent.id === orderId), 'save_party_size no resuelve PEDIR', compactValue(turn2.humanIntentAfter));
    trace.status = 'PASS';
  }, 480_000);

  it('CASE 03 — Resolve → Promote', async () => {
    const trace = await runCase('CASE 03 — Resolve → Promote', [
      'Quiero una milanesa y quiero saber qué postres tienen',
      'Quiero la milanesa de pollo',
      '¿Y los postres?',
    ]);
    const before = trace.turns[0].humanIntentAfter;
    const after = trace.turns[1].humanIntentAfter;
    assertLifecycleInvariant(trace, 1, 'INV-6', before.active.some((intent) => intent.goal === 'PEDIR') && before.pending.some((intent) => intent.goal === 'EXPLORAR'), 'ACTIVE PEDIR + PENDING EXPLORAR', compactValue(before));
    assertLifecycleInvariant(trace, 2, 'INV-5', after.active.some((intent) => intent.goal === 'EXPLORAR' && intentText(intent).includes('postres')), 'PENDING postres promovido a ACTIVE tras el efecto de PEDIR', compactValue(after));
    trace.status = 'PASS';
  }, 480_000);

  it('CASE 04 — Replace y cancelación de compra', async () => {
    const trace = await runCase('CASE 04 — Replace + CANCELAR_COMPRA', [
      'Quiero una milanesa de carne',
      'No, mejor una milanesa de pollo',
      'Cancelá el pedido',
    ]);
    const replacement = trace.turns[1];
    const openOrders = [...replacement.humanIntentAfter.active, ...replacement.humanIntentAfter.pending]
      .filter((intent) => intent.goal === 'PEDIR');
    assertLifecycleInvariant(trace, 2, 'INV-7', decisionName(replacement) === 'REPLACE', 'decisión REPLACE', compactValue(replacement.preflight));
    assertLifecycleInvariant(trace, 2, 'INV-7', openOrders.length <= 1, 'no quedan dos PEDIR abiertos', compactValue(openOrders));
    assertLifecycleInvariant(trace, 2, 'INV-7', intentText(openOrders[0] ?? { goal: '', request: [] }).includes('pollo'), 'el pedido vigente tiene objetivo pollo', compactValue(openOrders));
    assertLifecycleInvariant(trace, 2, 'INV-7', !replacement.toolCalls.some((call) => toolMentions(call, 'carne')), 'no se ejecuta add de carne durante el replace', compactValue(replacement.toolCalls));
    const cancel = trace.turns[2];
    assertLifecycleInvariant(trace, 3, 'INV-8', decisionName(cancel) !== 'CANCEL', 'CANCEL no se usa para cancelar la compra', compactValue(cancel.preflight));
    const cancellationGoal = ((cancel.preflight as { decision?: { intents?: Array<{ goal?: string }> } } | null)?.decision?.intents ?? []).some((intent) => intent.goal === 'CANCELAR_COMPRA');
    assertLifecycleInvariant(trace, 3, 'INV-8', cancellationGoal, 'preflight representa CANCELAR_COMPRA, no CANCEL de HumanIntent', compactValue(cancel.preflight));
    trace.status = 'PASS';
  }, 480_000);

  it('CASE 05 — Blocker + nueva intención', async () => {
    const trace = await runCase('CASE 05 — Blocker + nueva intención', [
      'Quiero una milanesa',
      'Grande',
      '¿Qué postres tienen?',
      'Quiero la milanesa de pollo',
      'La grande',
    ]);
    const turn3 = trace.turns[2];
    const orderId = trace.turns[0].humanIntentAfter.active[0]?.id;
    assertLifecycleInvariant(trace, 3, 'INV-6', turn3.humanIntentAfter.active.some((intent) => intent.goal === 'EXPLORAR' && intentText(intent).includes('postres')), 'EXPLORAR/postres toma ACTIVE temporalmente', compactValue(turn3.humanIntentAfter));
    assertLifecycleInvariant(trace, 3, 'INV-6', turn3.humanIntentAfter.pending.some((intent) => intent.id === orderId && intent.goal === 'PEDIR' && intentText(intent).includes('milanesa')), 'PEDIR/milanesa original queda PENDING', compactValue(turn3.humanIntentAfter));
    trace.status = 'PASS';
  }, 480_000);

  it('CASE 06 — Caso real: Ceviche + postres + bebidas', async () => {
    const trace = await runCase('CASE 06 — Ceviche + postres + bebidas', [
      'Quiero hacer un pedido',
      'Para 3',
      'Ceviche, postres y bebidas',
      'Quiero un ceviche',
      'Agregalo',
      '¿Qué postres tienen?',
      '¿Y bebidas?',
    ], { requirePartySize: true });
    const turn2 = trace.turns[1];
    const turn3 = trace.turns[2];
    const turn4 = trace.turns[3];
    const originalOrderId = trace.turns[0].humanIntentAfter.active[0]?.id;
    assertLifecycleInvariant(trace, 2, 'INV-9', decisionName(turn2) === 'CONTINUE_ACTIVE', 'respuesta party-size continúa ACTIVE', compactValue(turn2.preflight));
    assertLifecycleInvariant(trace, 2, 'INV-9', turn2.humanIntentAfter.active.some((intent) => intent.id === originalOrderId && intent.goal === 'PEDIR'), 'party size conserva el PEDIR ACTIVE original', compactValue(turn2.humanIntentAfter));
    assertLifecycleInvariant(trace, 2, 'INV-9', turn2.humanIntentAfter.records.filter((intent) => intent.goal === 'PEDIR' && (intent.status === 'ACTIVE' || intent.status === 'PENDING')).length === 1, 'party size no crea otra HumanIntent PEDIR', compactValue(turn2.humanIntentAfter));
    assertLifecycleInvariant(trace, 2, 'INV-9', turn2.toolCalls.some((call) => call.name === 'save_party_size' && (call.args as { count?: number })?.count === 3), 'save_party_size persiste count=3', compactValue(turn2.toolCalls));
    assertLifecycleInvariant(trace, 3, 'INV-6', turn3.humanIntentAfter.active.some((intent) => intent.goal === 'PEDIR' && intentText(intent).includes('ceviche')), 'ACTIVE PEDIR/ceviche', compactValue(turn3.humanIntentAfter));
    assertLifecycleInvariant(trace, 3, 'INV-6', turn3.humanIntentAfter.pending.filter((intent) => intent.goal === 'EXPLORAR').length >= 2, 'PENDING postres y bebidas', compactValue(turn3.humanIntentAfter));
    assertLifecycleInvariant(trace, 3, 'INV-6', !turn3.humanIntentAfter.pending.some((intent) => intent.goal === 'PEDIR'), 'sin PEDIR duplicada en PENDING', compactValue(turn3.humanIntentAfter));
    assertLifecycleInvariant(trace, 3, 'INV-2', !turn3.toolCalls.some((call) => toolMentions(call, 'postres') || toolMentions(call, 'bebidas')), 'no ejecutar exploración de postres/bebidas mientras PEDIR está ACTIVE', compactValue(turn3.toolCalls));
    assertLifecycleInvariant(trace, 4, 'INV-9', decisionName(turn4) !== 'NEW_INTENT', '“Quiero un ceviche” continúa la intención existente', compactValue(turn4.preflight));
    assertLifecycleInvariant(trace, 4, 'INV-9', decisionName(turn4) !== 'AMBIGUOUS' && !normalize(turn4.assistantResponse).includes('empezar otra'), 'no pide artificialmente continuar o empezar otra tarea', turn4.assistantResponse);
    assertLifecycleInvariant(trace, 4, 'INV-1', turn4.humanIntentAfter.active.length <= 1, 'sin intención PEDIR duplicada', compactValue(turn4.humanIntentAfter));
    assertLifecycleInvariant(trace, 6, 'INV-5', trace.turns[5].humanIntentAfter.active.some((intent) => intent.goal === 'EXPLORAR' && intentText(intent).includes('postres')) || trace.turns[5].humanIntentAfter.records.some((intent) => intent.goal === 'EXPLORAR' && intent.status === 'RESOLVED' && intentText(intent).includes('postres')), 'postres ACTIVE o RESOLVED al consultar su categoría', compactValue(trace.turns[5].humanIntentAfter));
    assertLifecycleInvariant(trace, 7, 'INV-5', trace.turns[6].humanIntentAfter.active.some((intent) => intent.goal === 'EXPLORAR' && intentText(intent).includes('bebidas')) || trace.turns[6].humanIntentAfter.records.some((intent) => intent.goal === 'EXPLORAR' && intent.status === 'RESOLVED' && intentText(intent).includes('bebidas')), 'bebidas ACTIVE o RESOLVED al consultar su categoría', compactValue(trace.turns[6].humanIntentAfter));
    trace.status = 'PASS';
  }, 600_000);

  it('CASE 07 — Party size → cantidad por línea → siguiente target', async () => {
    const trace = await runCase('CASE 07 — Quantity Goal multi-línea', [
      'Hola',
      'Quiero papas a la huancaína y ceviche',
      'Para 3 personas',
      '2',
    ], { requirePartySize: true });
    const orderPlanTurn = trace.turns[1];
    const partyTurn = trace.turns[2];
    const quantityTurn = trace.turns[3];
    const metadata = await (await import('./helpers/graphHarness'))
      .getFreshConversationMetadata(conversationId);
    const partyMetadata = partyTurn.conversationMetadataAfter;
    const plannedLines = (orderPlanTurn.conversationMetadataAfter?.pendingOrderLines as {
      lines?: Array<{ hint: string; requestedQuantity: number | null }>;
    } | undefined)?.lines;
    const pending = metadata?.pendingOrderLines as {
      lines?: Array<{ id: string; hint: string; requestedQuantity: number | null; status: string }>;
    } | undefined;
    const papas = pending?.lines?.find((line) => normalize(line.hint).includes('papas'));
    const ceviche = pending?.lines?.find((line) => normalize(line.hint).includes('ceviche'));
    const quantityCall = quantityTurn.toolCalls.find((call) => call.name === 'set_order_line_quantity');
    const partySizeCall = partyTurn.toolCalls.find((call) => call.name === 'save_party_size');
    let quantityToolResult: Record<string, unknown> = {};
    try {
      quantityToolResult = JSON.parse(quantityCall?.result ?? '{}') as Record<string, unknown>;
    } catch {
      quantityToolResult = {};
    }
    const persistedLine = quantityToolResult.orderLine as { requestedQuantity?: number } | undefined;
    const quantityArgs = quantityCall?.args as { orderLineId?: string } | undefined;
    const nextQuantityTarget = quantityToolResult.nextQuantityTarget as { id?: string } | undefined;
    const quantityGoalType = (
      quantityTurn.preflight as { decision?: { fulfillmentCandidate?: { goalType?: string } } } | null
    )?.decision?.fulfillmentCandidate?.goalType;

    const linesAfterParty = (partyMetadata?.pendingOrderLines as typeof pending)?.lines;
    assertLifecycleInvariant(trace, 2, 'INV-QTY-00', Boolean(plannedLines?.length === 2 && plannedLines.every((line) => line.requestedQuantity === null)), 'pendingOrderLines conserva ambas cantidades como UNKNOWN desde el plan', compactValue(plannedLines));
    assertLifecycleInvariant(trace, 3, 'INV-QTY-01', partyMetadata?.peopleCount === 3 && partyMetadata?.requestedPartySize === 3, 'peopleCount y requestedPartySize persisten 3', compactValue(partyMetadata));
    assertLifecycleInvariant(trace, 3, 'INV-QTY-02', Boolean(linesAfterParty?.length === 2 && linesAfterParty.every((line) => line.requestedQuantity === null)), 'ambas líneas siguen UNKNOWN tras guardar party size', compactValue(linesAfterParty));
    assertLifecycleInvariant(trace, 3, 'INV-QTY-11', Boolean(partySizeCall) && quantityGoalType === 'OBTENER_CANTIDAD_DEL_PRODUCTO', 'el siguiente preflight deriva el Quantity Goal tras party_size_persisted', compactValue(quantityTurn.preflight));
    assertLifecycleInvariant(trace, 3, 'INV-QTY-03', !partyTurn.toolCalls.some((call) => call.name === 'add_cart_item'), 'no hay ADD al guardar party size', compactValue(partyTurn.toolCalls));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-04', Boolean(quantityCall), 'el Goal usa la tool de persistencia de cantidad', compactValue(quantityTurn.toolCalls));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-12', quantityArgs?.orderLineId === papas?.id, 'la respuesta breve se vincula al id de la línea activa', compactValue(quantityCall));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-05', persistedLine?.requestedQuantity === 2, 'la respuesta 2 persiste solo la cantidad confirmada', compactValue(quantityCall));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-06', Boolean(papas && papas.requestedQuantity === 2 && papas.status === 'active'), 'papas conserva cantidad 2 y status active', compactValue(pending));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-07', Boolean(ceviche && ceviche.requestedQuantity == null && ceviche.status === 'queued'), 'ceviche sigue UNKNOWN y queued', compactValue(pending));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-08', quantityTurn.toolCalls.every((call) => call.name !== 'add_cart_item'), 'no se ejecuta ADD antes de obtener todas las cantidades', compactValue(quantityTurn.toolCalls));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-13', nextQuantityTarget?.id === ceviche?.id, 'la persistencia deriva ceviche como siguiente Quantity Goal target', compactValue(quantityToolResult));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-09', normalize(quantityTurn.assistantResponse).includes('ceviche'), 'el siguiente target comunicado es ceviche', quantityTurn.assistantResponse);
    trace.status = 'PASS';
  }, 600_000);

  it('P0 — ceviche + papas conserva el protocolo tool_call_id', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let trace: HumanIntentCaseTrace;
    try {
      trace = await runCase('P0 — ceviche + papas a la huacaina', [
        'Hola buenas quiero un ceviche y unas papas a la huacaina',
      ]);
    } finally {
      const errors = errorSpy.mock.calls.flat().map(String).join('\n');
      errorSpy.mockRestore();
      expect(errors).not.toMatch(/Invalid parameter:[\s\S]*tool_call_id/);
    }
    expect(trace!.turns[0].assistantResponse).not.toMatch(/Invalid parameter:[\s\S]*tool_call_id/);
  }, 480_000);
});
