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
    // Contrato MVP: ceviche sigue queued sin ProductResolution, así que no puede
    // ser Quantity Goal target; avanzar a ceviche es trabajo de add_cart_item +
    // continue_order_line, no de set_order_line_quantity.
    assertLifecycleInvariant(trace, 4, 'INV-QTY-13', nextQuantityTarget == null, 'sin siguiente Quantity Goal target para una línea sin ProductResolution', compactValue(quantityToolResult));
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
    const trace = await runCase('REGRESSION — multi-line quantity target binding (MVP Opción A)', [
      'Quiero un ceviche y unas papas',
      'Para 3',
      'El primero',
      '2',
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

    const QUANTITY_TURN = 4;
    const ADD_TURN = 5;
    const CONTINUE_TURN = 6;
    const PAPAS_QUANTITY_TURN = trace.turns.length;

    // --- TURN 4 ("2"): solo persistencia de cantidad del Ceviche ---
    const linesAfterQuantity = linesAt(QUANTITY_TURN);
    const ceviche = lineByHint(linesAfterQuantity, 'ceviche');
    const papas = lineByHint(linesAfterQuantity, 'papa');
    expect(ceviche, 'línea ceviche presente').toBeDefined();
    expect(papas, 'línea papas presente').toBeDefined();
    const cevicheResolutionId = ceviche?.currentResolutionId ?? null;

    expect(ceviche?.requestedQuantity, 'T4 ceviche.requestedQuantity').toBe(2);
    expect(ceviche?.status, 'T4 ceviche sigue active (sin fulfillment)').toBe('active');
    expect(cevicheResolutionId, 'T4 ceviche.currentResolutionId válido').toBeTruthy();
    expect(papas?.status, 'T4 papas queued').toBe('queued');
    expect(papas?.requestedQuantity, 'T4 papas.requestedQuantity').toBeNull();
    expect(papas?.currentResolutionId, 'T4 papas sin ProductResolution').toBeNull();

    const cevicheQuantityEntries = stageEvents(QUANTITY_TURN, 'set_order_line_quantity.entry');
    expect(cevicheQuantityEntries.length, 'T4 set_order_line_quantity ejecutado').toBeGreaterThanOrEqual(1);
    expect(cevicheQuantityEntries.every((entry) => entry.requestedOrderLineId === ceviche?.id), 'T4 set_order_line_quantity sobre ceviche').toBe(true);
    expect(cevicheQuantityEntries.at(-1)?.goalTargetOrderLineId, 'T4 Goal target == ceviche.id').toBe(ceviche?.id);
    expect(cevicheQuantityEntries.at(-1)?.confirmedQuantity, 'T4 quantity=2').toBe(2);
    expect(toolResults(QUANTITY_TURN, 'set_order_line_quantity').some((event) => event.success === true), 'T4 set_order_line_quantity success').toBe(true);
    // Un intento diferido sin mutación no viola el contrato; un add persistido sí.
    expect(toolResults(QUANTITY_TURN, 'add_cart_item').filter((event) => event.success === true), 'T4 sin add_cart_item persistido').toHaveLength(0);
    expect(modelToolCalls(QUANTITY_TURN, 'continue_order_line'), 'T4 sin continue_order_line').toHaveLength(0);
    expect(turnLogs[QUANTITY_TURN - 1]?.lineCloses, 'T4 sin advanceAfterLineClose').toEqual([]);
    expect((turnLogs[QUANTITY_TURN - 1]?.draftItems ?? []).length, 'T4 carrito vacío').toBe(0);

    // --- TURN 5 ("Agregalo"): fulfillment del Ceviche vía add_cart_item ---
    const addCalls = executedTools(ADD_TURN, 'add_cart_item');
    expect(addCalls.length, 'T5 add_cart_item ejecutado').toBeGreaterThanOrEqual(1);
    expect(addCalls.every((call) => call.orderLineId === ceviche?.id), 'T5 add_cart_item con orderLineId ceviche').toBe(true);
    expect(addCalls.at(-1)?.resolutionId, 'T5 add_cart_item con resolutionId del ceviche').toBe(cevicheResolutionId);
    expect(toolResults(ADD_TURN, 'add_cart_item').some((event) => event.success === true), 'T5 add_cart_item success').toBe(true);
    expect(turnLogs[ADD_TURN - 1]?.lineCloses, 'T5 cierre exacto de ceviche').toEqual([
      { lineId: ceviche?.id ?? null, closeStatus: 'done' },
    ]);
    // continue_order_line puede emitirse en el lote del add, pero no debe producir transición (order_line_still_active).
    expect(toolResults(ADD_TURN, 'continue_order_line').filter((event) => event.success === true), 'T5 sin continue_order_line exitoso').toHaveLength(0);

    const linesAfterAdd = linesAt(ADD_TURN);
    const cevicheAfterAdd = linesAfterAdd.find((line) => line.id === ceviche?.id);
    const papasAfterAdd = linesAfterAdd.find((line) => line.id === papas?.id);
    expect(cevicheAfterAdd?.status, 'T5 ceviche done').toBe('done');
    expect(cevicheAfterAdd?.requestedQuantity, 'T5 ceviche.requestedQuantity').toBe(2);
    expect(papasAfterAdd?.status, 'T5 papas sigue queued').toBe('queued');
    expect(papasAfterAdd?.currentResolutionId, 'T5 papas sin ProductResolution').toBeNull();

    const cevicheResolution = resolutionsAt(ADD_TURN).find((entry) => entry.resolutionId === cevicheResolutionId);
    expect(cevicheResolution?.status, 'T5 ProductResolution del ceviche consumida').toBe('consumed');
    const draftItems = turnLogs[ADD_TURN - 1]?.draftItems ?? [];
    expect(draftItems, 'T5 draft_order_item del ceviche').toHaveLength(1);
    expect(draftItems[0]?.product_id, 'T5 draft_order_item.product_id == ceviche').toBe(cevicheResolution?.productId);
    expect(draftItems[0]?.quantity, 'T5 draft_order_item.quantity').toBe(2);

    // --- TURN 6 ("Sí, seguí"): continue_order_line activa Papas ---
    expect(executedTools(CONTINUE_TURN, 'continue_order_line').length, 'T6 continue_order_line ejecutado').toBeGreaterThanOrEqual(1);
    expect(toolResults(CONTINUE_TURN, 'continue_order_line').some((event) => event.success === true), 'T6 continue_order_line success').toBe(true);
    const papasAfterContinue = linesAt(CONTINUE_TURN).find((line) => line.id === papas?.id);
    expect(papasAfterContinue?.status, 'T6 papas active').toBe('active');
    expect(modelToolCalls(CONTINUE_TURN, 'search_products').length, 'T6 search_products(papas)').toBeGreaterThanOrEqual(1);
    const continueTurnEvents = turnLogs[CONTINUE_TURN - 1]?.events ?? [];
    const continueDoneIndex = continueTurnEvents.findIndex((event) =>
      event.stage === 'ToolMessage.after_tool' && event.toolName === 'continue_order_line' && event.success === true
    );
    const firstLineWorkIndex = continueTurnEvents.findIndex((event) =>
      event.stage === 'HumanIntentToolNode.before_runTool' &&
      (event.toolName === 'search_products' || event.toolName === 'resolve_product')
    );
    expect(continueDoneIndex, 'T6 continue_order_line completado').toBeGreaterThanOrEqual(0);
    expect(firstLineWorkIndex, 'T6 search/resolve de papas solo después de continue_order_line').toBeGreaterThan(continueDoneIndex);
    expect(toolResults(CONTINUE_TURN, 'add_cart_item').filter((event) => event.success === true), 'T6 sin add_cart_item persistido de papas').toHaveLength(0);
    expect((turnLogs[CONTINUE_TURN - 1]?.draftItems ?? []).length, 'T6 carrito solo con ceviche').toBe(1);
    // DEFER order_line_quantity_required necesita input humano: el turno termina con su askMessage.
    expect(trace.turns[CONTINUE_TURN - 1]?.assistantResponse, 'T6 pregunta cantidad de papas').toMatch(/cu[aá]ntas unidades[\s\S]*papa/i);
    expect(executedTools(CONTINUE_TURN, 'set_order_line_quantity'), 'T6 sin set_order_line_quantity').toHaveLength(0);
    expect(executedTools(CONTINUE_TURN, 'clear_pending_add_quantity'), 'T6 sin clear_pending_add_quantity').toHaveLength(0);

    // ProductResolution asociada a Papas (puede requerir turnos de elección
    // si la búsqueda devuelve shortlist; nunca antes de continue_order_line).
    const papasResolutionTurn = Array.from({ length: PAPAS_QUANTITY_TURN - CONTINUE_TURN }, (_, i) => CONTINUE_TURN + i)
      .find((turn) => linesAt(turn).find((line) => line.id === papas?.id)?.currentResolutionId);
    expect(papasResolutionTurn, 'papas obtiene ProductResolution antes del turno de cantidad').toBeDefined();
    const papasBeforeQuantity = linesAt(PAPAS_QUANTITY_TURN - 1).find((line) => line.id === papas?.id);
    expect(papasBeforeQuantity?.status, 'papas active antes de "3"').toBe('active');
    expect(papasBeforeQuantity?.currentResolutionId, 'papas.currentResolutionId válido antes de "3"').toBeTruthy();
    expect(papasBeforeQuantity?.requestedQuantity, 'papas UNKNOWN antes de "3"').toBeNull();
    expect(
      stageEvents(papasResolutionTurn ?? CONTINUE_TURN, 'associateProductResolutionToTask.result')
        .some((event) => event.taskId === papas?.id && event.success === true),
      'ProductResolution asociada a la Task papas'
    ).toBe(true);

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

    const finalLines = linesAt(PAPAS_QUANTITY_TURN);
    expect(finalLines.find((line) => line.id === papas?.id)?.requestedQuantity, 'papas persistido=3').toBe(3);
    expect(finalLines.find((line) => line.id === ceviche?.id)?.requestedQuantity, 'ceviche sigue en 2').toBe(2);

    // --- Defensas: sin mismatches ni recursion limit en todo el escenario ---
    const allLogText = turnLogs.map((entry) => entry.rawText).join('\n');
    expect(allLogText.includes('goal_target_mismatch'), 'sin goal_target_mismatch').toBe(false);
    // task_resolution_mismatch es recuperable: cada uno debe traer nextRequiredTool y quedar
    // resuelto en el mismo turno por un resolve_product exitoso de esa Task y esa resolución.
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
        if (result.name !== 'add_cart_item' || result.payload.reason !== 'task_resolution_mismatch') return;
        const required = result.payload.nextRequiredToolArgs as
          | { orderLineId?: string; resolutionId?: string }
          | undefined;
        const recovered = result.payload.nextRequiredTool === 'resolve_product' &&
          required != null &&
          results.slice(position + 1).some((later) =>
            later.name === 'resolve_product' &&
            later.payload.success === true &&
            later.payload.orderLineId === required.orderLineId &&
            later.payload.currentResolutionId === required.resolutionId
          );
        expect(recovered, `T${index + 1} task_resolution_mismatch recuperado por resolve_product en el mismo turno`).toBe(true);
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
