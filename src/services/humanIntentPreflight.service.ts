import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getIntentDetectorLlm } from '../config/llm';
import {
  HUMAN_GOALS,
  mergeEquivalentPedirRequest,
  type HumanGoal,
  type HumanIntentRecord,
} from './humanIntentState.service';
import {
  buildHumanIntentPreflightUserPrompt,
  HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT,
} from '../prompts/humanIntentPreflight';

export interface HumanIntentPreflightInput {
  turn: {
    messageId: string;
    text: string;
  };
  context: {
    recentTurns: Array<{
      role: 'user' | 'assistant';
      text: string;
    }>;
    lastAssistantQuestion?: string;
    visibleReferences?: Array<{
      id: string;
      kind: 'product' | 'category' | 'cart_item' | 'reservation';
      label: string;
    }>;
    activeBlockingGoal?: 'OBTENER_PERSONAS_DEL_PEDIDO';
  };
  state: {
    revision: number;
    active: HumanIntentRecord | null;
    pending: HumanIntentRecord[];
  };
}

const requestSchema = z.record(z.string(), z.unknown());
const newIntentSchema = z.object({
  goal: z.enum(HUMAN_GOALS),
  request: requestSchema,
}).strict();

export const humanIntentTurnDecisionSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('NO_INTENT') }).strict(),
  z.object({
    decision: z.literal('CONTINUE_ACTIVE'),
    intentId: z.string().min(1),
    answeredBlockerIds: z.array(z.string()),
  }).strict(),
  z.object({
    decision: z.literal('NEW_INTENT'),
    intents: z.array(newIntentSchema).min(1).max(8),
  }).strict(),
  z.object({
    decision: z.literal('RESUME_PENDING'),
    intentId: z.string().min(1),
  }).strict(),
  z.object({
    decision: z.literal('CANCEL'),
    intentId: z.string().min(1),
  }).strict(),
  z.object({
    decision: z.literal('REPLACE'),
    intentId: z.string().min(1),
    replacement: newIntentSchema,
  }).strict(),
  z.object({ decision: z.literal('AMBIGUOUS') }).strict(),
]);

export type HumanIntentPreflightDecision = z.infer<typeof humanIntentTurnDecisionSchema>;

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const openIntents = (input: HumanIntentPreflightInput): HumanIntentRecord[] => [
  ...(input.state.active ? [input.state.active] : []),
  ...input.state.pending,
];

const ENTITY_ID_FIELDS = new Set([
  'id',
  'productId',
  'productIds',
  'categoryId',
  'categoryIds',
  'cartItemId',
  'cartItemIds',
  'reservationId',
  'reservationIds',
  'referenceId',
]);

const requestContainsOnlyKnownIds = (
  value: unknown,
  knownIds: Set<string>,
  fieldName?: string
): boolean => {
  if (Array.isArray(value)) {
    return value.every((item) => requestContainsOnlyKnownIds(item, knownIds, fieldName));
  }
  if (typeof value === 'string') {
    const isIdField =
      Boolean(fieldName) &&
      (ENTITY_ID_FIELDS.has(fieldName!) || /(?:^|[_-])ids?$/i.test(fieldName!) || /ids?$/i.test(fieldName!));
    const looksLikeUuid =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    return (!isIdField && !looksLikeUuid) || knownIds.has(value);
  }
  if (typeof value !== 'object' || value === null) return true;
  return Object.entries(value as Record<string, unknown>).every(([key, child]) =>
    requestContainsOnlyKnownIds(child, knownIds, key)
  );
};

const knownIdsFor = (input: HumanIntentPreflightInput): Set<string> =>
  new Set([
    ...openIntents(input).map((intent) => intent.id),
    ...(input.context.visibleReferences ?? []).map((reference) => reference.id),
  ]);

export const validateHumanIntentTurnDecision = (
  value: unknown,
  input: HumanIntentPreflightInput
): HumanIntentPreflightDecision | null => {
  const parsed = humanIntentTurnDecisionSchema.safeParse(value);
  if (!parsed.success) return null;

  const decision = parsed.data;
  const open = openIntents(input);
  if (decision.decision === 'CONTINUE_ACTIVE') {
    if (decision.intentId !== input.state.active?.id) return null;
    const blockerIds = new Set((input.state.active?.blockers ?? []).map((blocker) => blocker.id));
    if (decision.answeredBlockerIds.some((id) => !blockerIds.has(id))) return null;
    if (new Set(decision.answeredBlockerIds).size !== decision.answeredBlockerIds.length) return null;
  }
  if (decision.decision === 'RESUME_PENDING') {
    if (!input.state.pending.some((intent) => intent.id === decision.intentId)) return null;
  }
  if (decision.decision === 'CANCEL') {
    if (!open.some((intent) => intent.id === decision.intentId)) return null;
  }
  if (decision.decision === 'REPLACE') {
    if (decision.intentId !== input.state.active?.id) return null;
    if (!requestContainsOnlyKnownIds(decision.replacement.request, knownIdsFor(input))) return null;
  }
  if (decision.decision === 'NEW_INTENT') {
    const proposalKeys = new Set<string>();
    const knownIds = knownIdsFor(input);
    for (const proposal of decision.intents) {
      if (!requestContainsOnlyKnownIds(proposal.request, knownIds)) return null;
      const key = `${proposal.goal}:${canonicalJson(proposal.request)}`;
      if (proposalKeys.has(key)) return null;
      proposalKeys.add(key);
      if (
        open.some(
          (intent) =>
            intent.goal === proposal.goal &&
            canonicalJson(intent.request) === canonicalJson(proposal.request)
        ) &&
        !(
          proposal.goal === 'PEDIR' &&
          open.some(
            (intent) =>
              intent.goal === 'PEDIR' &&
              mergeEquivalentPedirRequest(intent.request, proposal.request) !== null
          )
        )
      ) {
        return null;
      }
    }
  }
  return decision;
};

export const runHumanIntentPreflight = async (
  input: HumanIntentPreflightInput
): Promise<HumanIntentPreflightDecision> => {
  if (!input.turn.messageId.trim() || !input.turn.text.trim()) {
    return { decision: 'AMBIGUOUS' };
  }

  try {
    const llm = getIntentDetectorLlm().withStructuredOutput(humanIntentTurnDecisionSchema);
    const result = await llm.invoke(
      [
        new SystemMessage(HUMAN_INTENT_PREFLIGHT_SYSTEM_PROMPT),
        new HumanMessage(buildHumanIntentPreflightUserPrompt(input)),
      ],
      { signal: AbortSignal.timeout(5000) }
    );
    return validateHumanIntentTurnDecision(result, input) ?? { decision: 'AMBIGUOUS' };
  } catch (error) {
    console.error('[human-intent-preflight] classification failed:', error);
    return { decision: 'AMBIGUOUS' };
  }
};

export const isHumanGoal = (value: unknown): value is HumanGoal =>
  typeof value === 'string' && (HUMAN_GOALS as readonly string[]).includes(value);