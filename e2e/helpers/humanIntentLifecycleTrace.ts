import type {
  HumanIntentRecord,
  HumanIntentStateV1,
} from '../../src/services/humanIntentState.service';

export type IntentSnapshot = {
  id: string;
  goal: string;
  status: string;
  request: string[];
  blockers: Array<{ id: string; code: string }>;
  outcome?: { kind: string; reference?: string; success: boolean };
};

export type HumanIntentSnapshot = {
  revision: number;
  active: IntentSnapshot[];
  pending: IntentSnapshot[];
  records: IntentSnapshot[];
};

export type LifecycleToolCall = {
  name: string;
  args: unknown;
  result: string;
};

export type LifecycleTurn = {
  turn: number;
  userMessage: string;
  preflight: unknown;
  humanIntentBefore: HumanIntentSnapshot;
  humanIntentAfter: HumanIntentSnapshot;
  toolCalls: LifecycleToolCall[];
  assistantResponse: string;
};

export type HumanIntentCaseTrace = {
  caseName: string;
  status: 'RUNNING' | 'PASS' | 'FAIL';
  turns: LifecycleTurn[];
  failure?: { invariant: string; turn: number; expected: string; observed: string };
};

const requestStrings = (value: unknown, key = ''): string[] => {
  if (Array.isArray(value)) return value.flatMap((entry) => requestStrings(entry, key));
  if (typeof value === 'string') {
    if (/id$/i.test(key) || !value.trim()) return [];
    return [value.trim()];
  }
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([childKey, child]) =>
    requestStrings(child, childKey)
  );
};

const snapshotIntent = (intent: HumanIntentRecord): IntentSnapshot => ({
  id: intent.id,
  goal: intent.goal,
  status: intent.status,
  request: requestStrings(intent.request).slice(0, 6),
  blockers: (intent.blockers ?? []).map(({ id, code }) => ({ id, code })),
  ...(intent.outcome
    ? {
        outcome: {
          kind: intent.outcome.kind,
          ...(intent.outcome.reference ? { reference: intent.outcome.reference } : {}),
          success: intent.outcome.success,
        },
      }
    : {}),
});

export const snapshotHumanIntentState = (state: HumanIntentStateV1): HumanIntentSnapshot => ({
  revision: state.revision,
  records: state.records.map(snapshotIntent),
  active: state.records
    .filter((intent) => intent.status === 'ACTIVE')
    .map(snapshotIntent),
  pending: state.records
    .filter((intent) => intent.status === 'PENDING')
    .sort((left, right) => left.sequence - right.sequence)
    .map(snapshotIntent),
});

export const compactValue = (value: unknown, maxLength = 280): string => {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const text = raw ?? String(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
};

const stateLines = (state: HumanIntentSnapshot): string[] => {
  const format = (intent: IntentSnapshot): string =>
    `${intent.goal} [${intent.id}]${intent.request.length ? ` {${intent.request.join(', ')}}` : ''}${intent.blockers.length ? ` blockers=${intent.blockers.map(({ code }) => code).join(',')}` : ''}`;
  return [
    `STATE revision=${state.revision}`,
    `ACTIVE ${state.active.length ? state.active.map(format).join(' | ') : '—'}`,
    `PENDING ${state.pending.length ? state.pending.map(format).join(' | ') : '—'}`,
    `TERMINAL ${state.records.filter((intent) => intent.status !== 'ACTIVE' && intent.status !== 'PENDING').map((intent) => `${format(intent)}${intent.outcome ? ` outcome=${intent.outcome.kind}:${intent.outcome.success}` : ''}`).join(' | ') || '—'}`,
  ];
};

export const formatHumanIntentTrace = (trace: HumanIntentCaseTrace): string => {
  const lines = [
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    `${trace.caseName}: ${trace.status}`,
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ];
  for (const turn of trace.turns) {
    lines.push(
      '',
      `TURN ${turn.turn}`,
      `USER ${turn.userMessage}`,
      `PREFLIGHT ${compactValue(turn.preflight, 500)}`,
      'HUMAN_INTENT_BEFORE',
      ...stateLines(turn.humanIntentBefore),
      'HUMAN_INTENT_AFTER',
      ...stateLines(turn.humanIntentAfter),
      `TOOLS ${turn.toolCalls.length ? turn.toolCalls.map((call) => `${call.name}(${compactValue(call.args, 180)}) -> ${call.result}`).join(' | ') : '—'}`,
      `ASSISTANT ${turn.assistantResponse || '—'}`,
      '────────────────────────────────────'
    );
  }
  if (trace.failure) {
    lines.push(
      `invariant: ${trace.failure.invariant}`,
      `turn: ${trace.failure.turn}`,
      `expected: ${trace.failure.expected}`,
      `observed: ${trace.failure.observed}`
    );
  }
  return lines.join('\n');
};

export const failLifecycleInvariant = (
  trace: HumanIntentCaseTrace,
  turn: number,
  invariant: string,
  expected: string,
  observed: string
): never => {
  trace.status = 'FAIL';
  trace.failure = { invariant, turn, expected, observed };
  throw new Error(`${formatHumanIntentTrace(trace)}\n`);
};

export const assertLifecycleInvariant = (
  trace: HumanIntentCaseTrace,
  turn: number,
  invariant: string,
  condition: boolean,
  expected: string,
  observed: string
): void => {
  if (!condition) failLifecycleInvariant(trace, turn, invariant, expected, observed);
};

export const traceJson = (traces: HumanIntentCaseTrace[]): string =>
  JSON.stringify(traces, null, 2);
