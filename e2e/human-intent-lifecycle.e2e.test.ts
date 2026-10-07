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
  getActiveDraftItems,
  loadMainGraph,
  type E2eDraftLine,
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
  overrides: [] as Array<(input: HumanIntentPreflightInput) => unknown>,
}));

vi.mock('../src/services/humanIntentPreflight.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/humanIntentPreflight.service')>();
  return {
    ...actual,
    runHumanIntentPreflight: async (input: HumanIntentPreflightInput) => {
      const override = preflightObservations.overrides.shift();
      const decision = override
        ? override(input)
        : await actual.runHumanIntentPreflight(input);
      preflightObservations.entries.push({ input, decision });
      return decision;
    },
  };
});

// Observa (sin alterar) los cierres de OrderLine: el contrato MVP exige que
// solo add_cart_item cierre la línea, nunca set_order_line_quantity.
const orderLineCloseObservations = vi.hoisted(() => ({
  calls: [] as Array<{ lineId: string | null; closeStatus: string }>,
}));

vi.mock('../src/services/pendingOrderLines.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/pendingOrderLines.service')>();
  return {
    ...actual,
    advanceAfterLineClose: async (params: Parameters<typeof actual.advanceAfterLineClose>[0]) => {
      orderLineCloseObservations.calls.push({
        lineId: params.lineId ?? null,
        closeStatus: params.closeStatus,
      });
      return actual.advanceAfterLineClose(params);
    },
  };
});

type TraceEvent = Record<string, unknown>;
type TurnLogs = {
  events: TraceEvent[];
  rawText: string;
  // console.error del turno: hybrid_react_failed / recursion limit no pasan por console.log.
  errorText: string;
  lineCloses: typeof orderLineCloseObservations.calls;
  draftItems: E2eDraftLine[];
};

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
  let businessId: string;
  const traces: HumanIntentCaseTrace[] = [];
  const turnLogsByTrace = new Map<HumanIntentCaseTrace, TurnLogs[]>();

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
    const orderLineTraces = [...turnLogsByTrace.entries()]
      .filter(([, turnLogs]) => turnLogs.length > 0)
      .map(([trace, turnLogs]) => ({
        caseName: trace.caseName,
        turns: turnLogs.map((entry, index) => ({
          turn: index + 1,
          userMessage: trace.turns[index]?.userMessage,
          lineCloses: entry.lineCloses,
          errors: entry.errorText,
          events: entry.events.filter((event) =>
            event.event === '[TRACE-ORDERLINE]' ||
            event.event === '[hybrid-agent] turn_awaits_user_input' ||
            event.event === '[hybrid-agent] turn_ends_after_fulfillment' ||
            event.event === '[hybrid-agent] turn_ends_task_recovery_failed' ||
            (typeof event.event === 'string' && (event.event.startsWith('[TOOLS ') || event.event.startsWith('[REACT ')))
          ),
        })),
      }));
    if (orderLineTraces.length > 0) {
      const orderLinePath = resolve(process.cwd(), 'e2e/.last-human-intent-orderline-trace.json');
      writeFileSync(orderLinePath, JSON.stringify(orderLineTraces, null, 2), 'utf8');
      console.log(`[TRACE-ORDERLINE] JSON: ${orderLinePath}`);
    }
    await disconnectPrisma();
  });

  const runCase = async (
    caseName: string,
    messages: string[],
    options?: {
      requirePartySize?: boolean;
      clearPartySizeBeforeTurn?: number[];
      preflightOverrides?: Array<(input: HumanIntentPreflightInput) => unknown>;
      captureTurnLogs?: boolean;
    }
  ): Promise<HumanIntentCaseTrace> => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    businessId = reset.businessId;
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
    preflightObservations.overrides.length = 0;
    preflightObservations.overrides.push(...(options?.preflightOverrides ?? []));

    const trace: HumanIntentCaseTrace = { caseName, status: 'RUNNING', turns: [] };
    traces.push(trace);
    const turnLogs: TurnLogs[] = [];
    turnLogsByTrace.set(trace, turnLogs);
    for (let index = 0; index < messages.length; index += 1) {
      if (options?.clearPartySizeBeforeTurn?.includes(index)) {
        await clearPartySize(conversationId);
      }
      const userMessage = messages[index];
      const payload = buildTextPayload(userMessage);
      const messageId = payload.entry[0].changes[0].value.messages?.[0].id ?? '';
      const before = await (await import('../src/services/humanIntentState.service'))
        .getHumanIntentState(conversationId);
      const callback = new ToolTraceCallback();
      orderLineCloseObservations.calls.length = 0;
      const logSpy = options?.captureTurnLogs
        ? vi.spyOn(console, 'log').mockImplementation(() => undefined)
        : null;
      const errorSpy = options?.captureTurnLogs
        ? vi.spyOn(console, 'error').mockImplementation(() => undefined)
        : null;
      let result: Awaited<ReturnType<MainGraph['invoke']>>;
      try {
        result = await graph.invoke(
          { webhookPayload: payload },
          { callbacks: [callback], runName: `human-intent-turn-${index + 1}` }
        );
      } finally {
        if (logSpy) {
          const rawEntries = logSpy.mock.calls.map(([entry]) => (typeof entry === 'string' ? entry : ''));
          logSpy.mockRestore();
          const errorText = (errorSpy?.mock.calls ?? [])
            .map((args) => args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '))
            .join('\n');
          errorSpy?.mockRestore();
          turnLogs.push({
            events: rawEntries.flatMap((entry) => {
              try {
                const parsed = JSON.parse(entry) as unknown;
                return typeof parsed === 'object' && parsed !== null ? [parsed as TraceEvent] : [];
              } catch {
                return [];
              }
            }),
            rawText: rawEntries.join('\n'),
            errorText,
            lineCloses: [...orderLineCloseObservations.calls],
            draftItems: [],
          });
        }
      }
      if (logSpy) turnLogs[turnLogs.length - 1].draftItems = await getActiveDraftItems(businessId);
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
    ], { requirePartySize: true, captureTurnLogs: true });
    // Evidencia de tools: logs [TRACE-ORDERLINE] / [TOOLS n] capturados por turno
    // (ToolTraceCallback no recibe las tools que ejecuta HumanIntentToolNode).
    const turnLogs = turnLogsByTrace.get(trace) ?? [];
    type Line = { id: string; hint: string; requestedQuantity: number | null; status: string; currentResolutionId: string | null };
    const linesAt = (turn: number): Line[] =>
      ((trace.turns[turn - 1]?.conversationMetadataAfter?.pendingOrderLines as { lines?: Line[] } | undefined)?.lines) ?? [];
    const stageEvents = (turn: number, stage: string): TraceEvent[] =>
      (turnLogs[turn - 1]?.events ?? []).filter((event) => event.event === '[TRACE-ORDERLINE]' && event.stage === stage);
    const executed = (turn: number, toolName: string): TraceEvent[] =>
      stageEvents(turn, 'HumanIntentToolNode.before_runTool').filter((event) => event.toolName === toolName);
    const succeeded = (turn: number, toolName: string): TraceEvent[] =>
      stageEvents(turn, 'ToolMessage.after_tool').filter((event) => event.toolName === toolName && event.success === true);
    const payloads = (turn: number, toolName: string): Array<Record<string, unknown>> =>
      (turnLogs[turn - 1]?.events ?? [])
        .filter((event) => typeof event.event === 'string' && event.event.startsWith('[TOOLS ') && event.name === toolName)
        .flatMap((event) => {
          try {
            return [JSON.parse(String(event.result)) as Record<string, unknown>];
          } catch {
            return [];
          }
        });

    const PLAN_TURN = 2;
    const PARTY_TURN = 3;
    const QUANTITY_TURN = 4;
    const quantityTurn = trace.turns[QUANTITY_TURN - 1];
    const plannedLines = linesAt(PLAN_TURN);
    const linesAfterParty = linesAt(PARTY_TURN);
    const papasBefore = linesAfterParty.find((line) => normalize(line.hint).includes('papas'));
    const linesAfterQuantity = linesAt(QUANTITY_TURN);
    const papas = linesAfterQuantity.find((line) => normalize(line.hint).includes('papas'));
    const ceviche = linesAfterQuantity.find((line) => normalize(line.hint).includes('ceviche'));
    const partyMetadata = trace.turns[PARTY_TURN - 1]?.conversationMetadataAfter;
    const quantityGoalType = (
      quantityTurn.preflight as { decision?: { fulfillmentCandidate?: { goalType?: string } } } | null
    )?.decision?.fulfillmentCandidate?.goalType;
    const quantityEntry = stageEvents(QUANTITY_TURN, 'set_order_line_quantity.entry').at(-1);
    const quantityPayload = payloads(QUANTITY_TURN, 'set_order_line_quantity').find((payload) => payload.success === true);
    const addCalls = executed(QUANTITY_TURN, 'add_cart_item');
    const papasProductId = ((quantityTurn.conversationMetadataAfter?.productResolutions as
      Array<{ resolutionId: string; productId: string }> | undefined) ?? [])
      .find((entry) => entry.resolutionId === papas?.currentResolutionId)?.productId;
    const draftAfterQuantity = turnLogs[QUANTITY_TURN - 1]?.draftItems ?? [];

    assertLifecycleInvariant(trace, 2, 'INV-QTY-00', Boolean(plannedLines.length === 2 && plannedLines.every((line) => line.requestedQuantity === null)), 'pendingOrderLines conserva ambas cantidades como UNKNOWN desde el plan', compactValue(plannedLines));
    assertLifecycleInvariant(trace, 3, 'INV-QTY-01', partyMetadata?.peopleCount === 3 && partyMetadata?.requestedPartySize === 3, 'peopleCount y requestedPartySize persisten 3', compactValue(partyMetadata));
    assertLifecycleInvariant(trace, 3, 'INV-QTY-02', Boolean(linesAfterParty.length === 2 && linesAfterParty.every((line) => line.requestedQuantity === null)), 'ambas líneas siguen UNKNOWN tras guardar party size', compactValue(linesAfterParty));
    assertLifecycleInvariant(trace, 3, 'INV-QTY-11', succeeded(PARTY_TURN, 'save_party_size').length >= 1 && quantityGoalType === 'OBTENER_CANTIDAD_DEL_PRODUCTO', 'save_party_size exitoso y el siguiente preflight deriva el Quantity Goal', compactValue({ partySize: executed(PARTY_TURN, 'save_party_size'), preflight: quantityTurn.preflight }));
    assertLifecycleInvariant(trace, 3, 'INV-QTY-03', succeeded(PARTY_TURN, 'add_cart_item').length === 0 && (turnLogs[PARTY_TURN - 1]?.draftItems ?? []).length === 0, 'no hay ADD persistido al guardar party size', compactValue(executed(PARTY_TURN, 'add_cart_item')));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-04', Boolean(quantityEntry), 'el Goal usa la tool de persistencia de cantidad', compactValue(stageEvents(QUANTITY_TURN, 'set_order_line_quantity.entry')));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-12', quantityEntry?.requestedOrderLineId === papasBefore?.id && quantityEntry?.goalTargetOrderLineId === papasBefore?.id, 'la respuesta breve se vincula al id de la línea activa (Goal target)', compactValue(quantityEntry));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-05', quantityEntry?.confirmedQuantity === 2 && (quantityPayload?.orderLine as { requestedQuantity?: number } | undefined)?.requestedQuantity === 2, 'la respuesta 2 persiste solo la cantidad confirmada (sin cantidad inventada)', compactValue(quantityPayload));
    // Quantity Goal → fulfillment: con su cantidad persistida, la Task papas se agrega y cierra en el mismo turno.
    assertLifecycleInvariant(trace, 4, 'INV-QTY-06', Boolean(papas && papas.id === papasBefore?.id && papas.requestedQuantity === 2 && papas.status === 'done'), 'papas persiste cantidad 2 y queda DONE por el add del mismo turno', compactValue(linesAfterQuantity));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-07', Boolean(ceviche && ceviche.requestedQuantity == null && ceviche.status === 'queued' && ceviche.currentResolutionId == null), 'ceviche sigue UNKNOWN, QUEUED y sin ProductResolution', compactValue(linesAfterQuantity));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-08', addCalls.length >= 1 && addCalls.every((call) => call.effectiveOrderLineId === papasBefore?.id) && succeeded(QUANTITY_TURN, 'add_cart_item').length === 1, 'un único ADD exitoso y solo de la línea cuya cantidad se persistió (nunca ceviche)', compactValue(addCalls));
    assertLifecycleInvariant(trace, 4, 'INV-QTY-14', draftAfterQuantity.length === 1 && draftAfterQuantity[0]?.quantity === 2 && Boolean(papasProductId) && draftAfterQuantity[0]?.product_id === papasProductId, 'carrito: un solo ítem, el producto de papas, cantidad 2 (sin duplicado ni producto equivocado)', compactValue(draftAfterQuantity));
    // Contrato MVP: ceviche sigue queued sin ProductResolution, así que no puede ser Quantity Goal
    // target; la transición de la cantidad persistida es el fulfillment de papas.
    assertLifecycleInvariant(trace, 4, 'INV-QTY-13', quantityPayload?.nextQuantityTarget == null && quantityPayload?.nextRequiredTool === 'add_cart_item' && (quantityPayload?.nextRequiredToolArgs as { orderLineId?: string } | undefined)?.orderLineId === papasBefore?.id, 'sin siguiente Quantity Goal target; la transición es add_cart_item de papas', compactValue(quantityPayload));
    trace.status = 'PASS';
  }, 600_000);

  it('REGRESSION — selected OrderLine resolves quantity before add', async () => {
    const trace = await runCase('REGRESSION — selected OrderLine resolves quantity before add', [
      'Quiero un ceviche y unas papas a la huacaina',
      'Somos 4',
      'Quiero el Ceviche Clásico',
      'Para 3',
    ], { requirePartySize: true, clearPartySizeBeforeTurn: [1] });

    const firstTurn = trace.turns[0];
    const partyTurn = trace.turns[1];
    const selectionTurn = trace.turns[2];
    const quantityTurn = trace.turns[3];

    expect(decisionName(firstTurn)).toBe('NEW_INTENT');
    expect(decisionName(partyTurn)).toBe('CONTINUE_ACTIVE');
    expect(partyTurn.conversationMetadataAfter?.peopleCount).toBe(4);
    expect(selectionTurn.humanIntentBefore.active.length).toBe(1);
    expect(selectionTurn.humanIntentBefore.active[0]?.id).toBe(partyTurn.humanIntentAfter.active[0]?.id);
    expect(selectionTurn.preflight).toMatchObject({
      decision: {
        decision: 'CONTINUE_ACTIVE',
        intentId: selectionTurn.humanIntentBefore.active[0]?.id,
      },
    });

    const lineResolution = selectionTurn.conversationMetadataAfter?.pendingOrderLines as {
      lines?: Array<{
        id?: string;
        currentResolutionId?: string | null;
        hint?: string;
        requestedQuantity?: number | null;
      }>;
    } | undefined;
    const activeLine = lineResolution?.lines?.find((line) => line.hint === 'ceviche' || normalize(line.hint ?? '').includes('ceviche'));

    expect(activeLine?.currentResolutionId).toBeTruthy();
    expect(activeLine?.requestedQuantity).toBeNull();
    expect(selectionTurn.assistantResponse).toMatch(/cu[aá]ntas unidades|cantidad/i);
    expect(
      (quantityTurn.preflight as { decision?: { fulfillmentCandidate?: { goalType?: string } } } | null)
        ?.decision?.fulfillmentCandidate?.goalType
    ).toBe('OBTENER_CANTIDAD_DEL_PRODUCTO');
    expect(quantityTurn.humanIntentAfter.active.length).toBe(1);
    expect(quantityTurn.humanIntentAfter.active[0]?.id).toBe(selectionTurn.humanIntentAfter.active[0]?.id);
    expect(quantityTurn.conversationMetadataAfter?.peopleCount).toBe(4);
    const quantityLine = (quantityTurn.conversationMetadataAfter?.pendingOrderLines as {
      lines?: Array<{ id?: string; currentResolutionId?: string | null; requestedQuantity?: number | null }>;
    } | undefined)?.lines?.find((line) => line.id === activeLine?.id);
    expect(quantityLine?.requestedQuantity).toBe(3);
    expect(quantityLine?.currentResolutionId).toBe(activeLine?.currentResolutionId);

    trace.status = 'PASS';
  }, 900_000);

  // Contrato MVP (Opción A): set_order_line_quantity solo persiste la cantidad;
  // add_cart_item hace el fulfillment y cierra la OrderLine; continue_order_line
  // activa la siguiente. Ninguno de esos pasos ocurre implícitamente.
  it('REGRESSION — multi-line quantity stays bound to the prompted OrderLine', async () => {
    const trace = await runCase('REGRESSION — multi-line quantity target binding (Quantity Goal → fulfillment)', [
      'Quiero un ceviche y unas papas',
      'Para 3',
      'El primero',
      'Dame 2',
      'Agregalo',
      'Sí, seguí',
      '3',
    ], { requirePartySize: true, clearPartySizeBeforeTurn: [1], captureTurnLogs: true });

    type Line = {
      id: string;
      hint: string;
      status: string;
      requestedQuantity: number | null;
      currentResolutionId: string | null;
    };
    const turnLogs = turnLogsByTrace.get(trace) ?? [];
    const linesAt = (turn: number): Line[] =>
      ((trace.turns[turn - 1]?.conversationMetadataAfter?.pendingOrderLines as { lines?: Line[] } | undefined)
        ?.lines) ?? [];
    const resolutionsAt = (turn: number): Array<{ resolutionId: string; productId: string; status: string }> =>
      (trace.turns[turn - 1]?.conversationMetadataAfter?.productResolutions as
        Array<{ resolutionId: string; productId: string; status: string }> | undefined) ?? [];
    const stageEvents = (turn: number, stage: string): TraceEvent[] =>
      (turnLogs[turn - 1]?.events ?? []).filter(
        (event) => event.event === '[TRACE-ORDERLINE]' && event.stage === stage
      );
    const modelToolCalls = (turn: number, toolName: string): TraceEvent[] =>
      stageEvents(turn, 'AIMessage.tool_call').filter((event) => event.toolName === toolName);
    // HumanIntentToolNode.runTool es el punto común de ejecución: ToolExecutor
    // solo interviene en cadenas search→resolve; una tool aislada va directo.
    const executedTools = (turn: number, toolName: string): TraceEvent[] =>
      stageEvents(turn, 'HumanIntentToolNode.before_runTool')
        .filter((event) => event.toolName === toolName)
        .map((event) => {
          const modelArgs = (event.modelArgs ?? {}) as Record<string, unknown>;
          return {
            ...event,
            orderLineId: event.effectiveOrderLineId ?? null,
            resolutionId: typeof modelArgs.resolutionId === 'string' ? modelArgs.resolutionId : null,
          };
        });
    const toolResults = (turn: number, toolName: string): TraceEvent[] =>
      stageEvents(turn, 'ToolMessage.after_tool').filter((event) => event.toolName === toolName);
    const lineByHint = (lines: Line[], hint: string): Line | undefined =>
      lines.find((line) => normalize(line.hint).includes(hint));

    const toolPayloads = (turn: number, toolName: string): Array<Record<string, unknown>> =>
      (turnLogs[turn - 1]?.events ?? [])
        .filter((event) => typeof event.event === 'string' && event.event.startsWith('[TOOLS ') && event.name === toolName)
        .flatMap((event) => {
          try {
            return [JSON.parse(String(event.result)) as Record<string, unknown>];
          } catch {
            return [];
          }
        });

    const QUANTITY_TURN = 4;
    const AGREGALO_TURN = 5;
    const CONTINUE_TURN = 6;
    const PAPAS_QUANTITY_TURN = trace.turns.length;

    // --- TURN 3 ("El primero"): ceviche resuelto; aunque el modelo se adelante a papas (QUEUED),
    // el turno termina preguntando la cantidad de la línea ACTIVE (ceviche).
    expect(trace.turns[2]?.assistantResponse, 'T3 pregunta cantidad de ceviche').toMatch(/cu[aá]ntas unidades[\s\S]*ceviche/i);
    expect(trace.turns[2]?.assistantResponse, 'T3 sin mensaje de error').not.toMatch(/No pude confirmar/i);

    // --- TURN 4 ("Dame 2"): cantidad persistida → fulfillment del Ceviche en el mismo turno ---
    const linesAfterQuantity = linesAt(QUANTITY_TURN);
    const ceviche = lineByHint(linesAfterQuantity, 'ceviche');
    const papas = lineByHint(linesAfterQuantity, 'papa');
    expect(ceviche, 'línea ceviche presente').toBeDefined();
    expect(papas, 'línea papas presente').toBeDefined();
    const cevicheResolutionId = ceviche?.currentResolutionId ?? null;
    expect(cevicheResolutionId, 'T4 ceviche.currentResolutionId válido').toBeTruthy();

    const cevicheQuantityEntries = stageEvents(QUANTITY_TURN, 'set_order_line_quantity.entry');
    expect(cevicheQuantityEntries.length, 'T4 set_order_line_quantity ejecutado').toBeGreaterThanOrEqual(1);
    expect(cevicheQuantityEntries.every((entry) => entry.requestedOrderLineId === ceviche?.id), 'T4 set_order_line_quantity sobre ceviche').toBe(true);
    expect(cevicheQuantityEntries.at(-1)?.goalTargetOrderLineId, 'T4 Goal target == ceviche.id').toBe(ceviche?.id);
    expect(cevicheQuantityEntries.at(-1)?.confirmedQuantity, 'T4 quantity=2').toBe(2);
    const quantityPayload = toolPayloads(QUANTITY_TURN, 'set_order_line_quantity').find((payload) => payload.success === true);
    expect(quantityPayload?.nextRequiredTool, 'T4 fulfillment ready → nextRequiredTool add_cart_item').toBe('add_cart_item');
    expect(quantityPayload?.nextRequiredToolArgs, 'T4 nextRequiredToolArgs del estado persistido').toMatchObject({
      orderLineId: ceviche?.id,
      resolutionId: cevicheResolutionId,
      quantity: 2,
    });

    const addCalls = executedTools(QUANTITY_TURN, 'add_cart_item');
    expect(addCalls.length, 'T4 add_cart_item ejecutado').toBeGreaterThanOrEqual(1);
    expect(addCalls.every((call) => call.orderLineId === ceviche?.id), 'T4 add_cart_item con orderLineId ceviche').toBe(true);
    expect(addCalls.at(-1)?.resolutionId, 'T4 add_cart_item con resolutionId del ceviche').toBe(cevicheResolutionId);
    expect(toolResults(QUANTITY_TURN, 'add_cart_item').some((event) => event.success === true), 'T4 add_cart_item success').toBe(true);
    expect(turnLogs[QUANTITY_TURN - 1]?.lineCloses, 'T4 cierre exacto de ceviche').toEqual([
      { lineId: ceviche?.id ?? null, closeStatus: 'done' },
    ]);
    expect(toolResults(QUANTITY_TURN, 'continue_order_line').filter((event) => event.success === true), 'T4 sin continue_order_line exitoso').toHaveLength(0);

    expect(ceviche?.status, 'T4 ceviche DONE').toBe('done');
    expect(ceviche?.requestedQuantity, 'T4 ceviche.requestedQuantity').toBe(2);
    expect(papas?.status, 'T4 papas QUEUED').toBe('queued');
    expect(papas?.requestedQuantity, 'T4 papas.requestedQuantity').toBeNull();
    expect(papas?.currentResolutionId, 'T4 papas sin ProductResolution').toBeNull();

    const cevicheResolution = resolutionsAt(QUANTITY_TURN).find((entry) => entry.resolutionId === cevicheResolutionId);
    expect(cevicheResolution?.status, 'T4 ProductResolution del ceviche consumida').toBe('consumed');
    const draftItems = turnLogs[QUANTITY_TURN - 1]?.draftItems ?? [];
    expect(draftItems, 'T4 draft_order_item del ceviche').toHaveLength(1);
    expect(draftItems[0]?.product_id, 'T4 draft_order_item.product_id == ceviche').toBe(cevicheResolution?.productId);
    expect(draftItems[0]?.quantity, 'T4 draft_order_item.quantity').toBe(2);
    expect(trace.turns[QUANTITY_TURN - 1]?.assistantResponse, 'T4 sin "Cantidad anotada" tras el agregado').not.toMatch(/Cantidad anotada/i);

    // --- TURN 5 ("Agregalo"): ceviche ya está cerrado; no hay add duplicado ni contaminación de papas ---
    const draftAfterAgregalo = turnLogs[AGREGALO_TURN - 1]?.draftItems ?? [];
    expect(draftAfterAgregalo, 'T5 carrito sigue con un único ceviche').toHaveLength(1);
    expect(draftAfterAgregalo[0]?.quantity, 'T5 ceviche sigue en 2 en el carrito').toBe(2);
    const cevicheAfterAgregalo = linesAt(AGREGALO_TURN).find((line) => line.id === ceviche?.id);
    expect(cevicheAfterAgregalo?.status, 'T5 ceviche sigue DONE').toBe('done');
    const papasAfterAgregalo = linesAt(AGREGALO_TURN).find((line) => line.id === papas?.id);
    if (papasAfterAgregalo?.status === 'queued') {
      expect(papasAfterAgregalo.currentResolutionId, 'T5 papas QUEUED sin ProductResolution').toBeNull();
    }

    // --- Activación de Papas: continue_order_line exitoso en T5 o T6, antes de cualquier resolve de papas ---
    const activationTurns = [AGREGALO_TURN, CONTINUE_TURN].filter((turn) =>
      toolResults(turn, 'continue_order_line').some((event) => event.success === true)
    );
    expect(activationTurns, 'papas activada por un único continue_order_line exitoso').toHaveLength(1);
    const activationTurn = activationTurns[0] ?? CONTINUE_TURN;
    const activationEvents = turnLogs[activationTurn - 1]?.events ?? [];
    const continueDoneIndex = activationEvents.findIndex((event) =>
      event.stage === 'ToolMessage.after_tool' && event.toolName === 'continue_order_line' && event.success === true
    );
    const firstPapasResolveIndex = activationEvents.findIndex((event) =>
      event.stage === 'associateProductResolutionToTask.result' && event.taskId === papas?.id
    );
    if (firstPapasResolveIndex >= 0) {
      expect(firstPapasResolveIndex, 'resolve de papas solo después de continue_order_line').toBeGreaterThan(continueDoneIndex);
    }
    for (let turn = QUANTITY_TURN; turn < activationTurn; turn += 1) {
      expect(
        stageEvents(turn, 'associateProductResolutionToTask.result').some((event) => event.taskId === papas?.id && event.success === true),
        `T${turn} papas sin ProductResolution antes de activarse`
      ).toBe(false);
    }
    expect(linesAt(CONTINUE_TURN).find((line) => line.id === papas?.id)?.status, 'T6 papas active').toBe('active');
    expect((turnLogs[CONTINUE_TURN - 1]?.draftItems ?? []).length, 'T6 carrito solo con ceviche').toBe(1);

    // ProductResolution asociada a Papas y pregunta de cantidad en ese turno (nunca antes de activarse).
    const papasResolutionTurn = Array.from({ length: PAPAS_QUANTITY_TURN - activationTurn }, (_, i) => activationTurn + i)
      .find((turn) => linesAt(turn).find((line) => line.id === papas?.id)?.currentResolutionId);
    expect(papasResolutionTurn, 'papas obtiene ProductResolution antes del turno de cantidad').toBeDefined();
    const papasBeforeQuantity = linesAt(PAPAS_QUANTITY_TURN - 1).find((line) => line.id === papas?.id);
    expect(papasBeforeQuantity?.status, 'papas active antes de "3"').toBe('active');
    expect(papasBeforeQuantity?.currentResolutionId, 'papas.currentResolutionId válido antes de "3"').toBeTruthy();
    expect(papasBeforeQuantity?.requestedQuantity, 'papas UNKNOWN antes de "3"').toBeNull();
    expect(
      stageEvents(papasResolutionTurn ?? activationTurn, 'associateProductResolutionToTask.result')
        .some((event) => event.taskId === papas?.id && event.success === true),
      'ProductResolution asociada a la Task papas'
    ).toBe(true);
    // DEFER order_line_quantity_required necesita input humano: el turno termina con su askMessage.
    expect(trace.turns[(papasResolutionTurn ?? activationTurn) - 1]?.assistantResponse, 'pregunta cantidad de papas').toMatch(/cu[aá]ntas unidades[\s\S]*papa/i);
    expect(executedTools(papasResolutionTurn ?? activationTurn, 'set_order_line_quantity'), 'sin set_order_line_quantity al resolver papas').toHaveLength(0);
    expect(executedTools(papasResolutionTurn ?? activationTurn, 'clear_pending_add_quantity'), 'sin clear_pending_add_quantity al resolver papas').toHaveLength(0);

    // --- TURN "3": cantidad de Papas ligada a su Quantity Goal ---
    const papasQuantityTurn = trace.turns[PAPAS_QUANTITY_TURN - 1];
    expect(
      (papasQuantityTurn.preflight as { decision?: { fulfillmentCandidate?: { goalType?: string } } } | null)
        ?.decision?.fulfillmentCandidate?.goalType,
      'goal OBTENER_CANTIDAD_DEL_PRODUCTO'
    ).toBe('OBTENER_CANTIDAD_DEL_PRODUCTO');
    const papasQuantityEntries = stageEvents(PAPAS_QUANTITY_TURN, 'set_order_line_quantity.entry');
    expect(papasQuantityEntries.length, 'set_order_line_quantity ejecutado para papas').toBeGreaterThanOrEqual(1);
    expect(papasQuantityEntries.at(-1)?.goalTargetOrderLineId, 'Goal target == papas.id').toBe(papas?.id);
    expect(papasQuantityEntries.at(-1)?.requestedOrderLineId, 'orderLineId == papas.id').toBe(papas?.id);
    expect(papasQuantityEntries.at(-1)?.confirmedQuantity, 'papas quantity=3').toBe(3);
    expect(
      papasQuantityEntries.some((entry) => entry.requestedOrderLineId === ceviche?.id),
      'sin set_order_line_quantity contra ceviche'
    ).toBe(false);
    expect(toolResults(PAPAS_QUANTITY_TURN, 'set_order_line_quantity').some((event) => event.success === true), 'set_order_line_quantity papas success').toBe(true);

    // Con todas las líneas cerradas pendingOrderLines desaparece: las cantidades se verifican en el carrito.
    const finalDraft = turnLogs[PAPAS_QUANTITY_TURN - 1]?.draftItems ?? [];
    const papasProductId = resolutionsAt(PAPAS_QUANTITY_TURN - 1)
      .find((entry) => entry.resolutionId === papasBeforeQuantity?.currentResolutionId)?.productId;
    expect(finalDraft.find((item) => item.product_id === papasProductId)?.quantity, 'papas ×3 en el carrito').toBe(3);
    expect(finalDraft.find((item) => item.product_id === cevicheResolution?.productId)?.quantity, 'ceviche sigue ×2 en el carrito').toBe(2);
    const finalLines = linesAt(PAPAS_QUANTITY_TURN);
    expect(finalLines.filter((line) => line.status === 'active' || line.status === 'queued'), 'sin líneas abiertas al final').toHaveLength(0);

    // --- Defensas: sin mismatches ni recursion limit en todo el escenario ---
    const allLogText = turnLogs.map((entry) => entry.rawText).join('\n');
    expect(allLogText.includes('goal_target_mismatch'), 'sin goal_target_mismatch').toBe(false);
    // task_resolution_mismatch / task_already_associated son recuperables: cada uno debe traer
    // nextRequiredTool y quedar resuelto en el mismo turno, por resolve_product (Task sin
    // resolución) o por un add posterior con la resolución canónica de la Task (sin otro mismatch).
    turnLogs.forEach((entry, index) => {
      const results = entry.events
        .filter((event) => typeof event.event === 'string' && event.event.startsWith('[TOOLS '))
        .map((event) => {
          let payload: Record<string, unknown> = {};
          try {
            payload = JSON.parse(String(event.result)) as Record<string, unknown>;
          } catch {
            payload = {};
          }
          return { name: event.name, payload };
        });
      results.forEach((result, position) => {
        const rejection = (result.name === 'add_cart_item' && result.payload.reason === 'task_resolution_mismatch') ||
          (result.name === 'resolve_product' && result.payload.reason === 'task_already_associated');
        if (!rejection) return;
        const required = result.payload.nextRequiredToolArgs as
          | { orderLineId?: string; resolutionId?: string }
          | undefined;
        const later = results.slice(position + 1);
        const recoveredByResolve = result.payload.nextRequiredTool === 'resolve_product' &&
          required != null &&
          later.some((next) =>
            next.name === 'resolve_product' &&
            next.payload.success === true &&
            next.payload.orderLineId === required.orderLineId &&
            next.payload.currentResolutionId === required.resolutionId
          );
        const recoveredCanonically = result.payload.nextRequiredTool === 'add_cart_item' &&
          required != null &&
          later.some((next) =>
            next.name === 'add_cart_item' &&
            next.payload.reason !== 'task_resolution_mismatch' &&
            (next.payload.success === true || typeof next.payload.reason === 'string')
          );
        // Sin recuperación explotable en este turno (fail closed, p. ej. Task QUEUED, o un segundo
        // mismatch tras ya haber ofrecido la recuperación canónica): válido si el runtime detectó eso
        // y cortó el turno con una respuesta segura (pregunta de la Task ACTIVE o fallback genérico),
        // en vez de dejar que el modelo siguiera reintentando. El payload del rechazo puede seguir
        // trayendo nextRequiredTool (es la misma recuperación ya ofrecida antes): lo que importa es que
        // el turno, a nivel runtime, no permitió un tercer intento.
        const endedSafely = entry.events.some((event) => event.event === '[hybrid-agent] turn_ends_task_recovery_failed');
        expect(recoveredByResolve || recoveredCanonically || endedSafely, `T${index + 1} ${String(result.payload.reason)} recuperado o cerrado de forma segura en el mismo turno`).toBe(true);
      });
    });
    expect(/recursion limit|GraphRecursionError/i.test(allLogText), 'sin recursion limit').toBe(false);
    turnLogs.forEach((entry, index) => {
      expect(/hybrid_react_failed|recursion limit|GraphRecursionError/i.test(entry.errorText), `T${index + 1} sin hybrid_react_failed / recursion limit`).toBe(false);
    });
    turnLogs.forEach((entry, index) => {
      const reactIterations = entry.events.filter(
        (event) => typeof event.event === 'string' && event.event.startsWith('[REACT ')
      ).length;
      expect(reactIterations, `T${index + 1} sin recursion limit`).toBeLessThan(12);
    });

    trace.status = 'PASS';
  }, 900_000);
});
