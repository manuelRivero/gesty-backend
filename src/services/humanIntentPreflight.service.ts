import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { getIntentDetectorLlm } from '../config/llm';
import {
  getGoalFulfillmentContract,
  INTENT_CATALOG,
  isIntentType,
  type GoalFulfillmentCandidate,
  type IntentType,
} from '../domain/intent/family';
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
    activeBlockingGoal?: IntentType;
    /**
     * Oferta de compra viva (CONFIRMAR_OFERTA, ver `lastOffer.service.ts`): el
     * asistente ya propuso agregar este producto y no venció. Solo evidencia
     * para que el clasificador reconozca una aceptación explícita como
     * NEW_INTENT PEDIR — nunca se asume una transición sin que el mensaje la
     * exprese con claridad (ver reglas del prompt).
     */
    activeOffer?: { productId: string; productName: string } | null;
    /**
     * Referente conversacional informativo (`lastInformationalProductRef`,
     * ver `informationalProductRef.service.ts`): último producto del que se
     * habló en una consulta de catálogo (no de compra). A diferencia de
     * `activeOffer`, el asistente nunca propuso agregarlo — por eso NUNCA
     * autoriza por sí solo una aceptación desnuda ("ok", "dale"); solo
     * permite resolver el productId cuando el propio mensaje expresa una
     * intención de compra explícita sin nombrar el plato (ver reglas del
     * prompt). Ausente/null si no hay referente vigente, si venció, o si hay
     * una selección pendiente ambigua (`pendingProductSelection`) — en ese
     * caso ya no llega acá, por diseño de `getApplicableInformationalProductRef`.
     */
    recentProductRef?: { productId: string; productName: string } | null;
  };
  state: {
    revision: number;
    active: HumanIntentRecord | null;
    pending: HumanIntentRecord[];
  };
}

const requestSchema = z.record(z.string(), z.unknown());
const intentTypeSchema = z.enum(Object.keys(INTENT_CATALOG) as [IntentType, ...IntentType[]]);
const fulfillmentCandidateSchema = z.object({ goalType: intentTypeSchema }).strict();
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
    fulfillmentCandidate: fulfillmentCandidateSchema.optional(),
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
    ...(input.context.activeOffer ? [input.context.activeOffer.productId] : []),
    ...(input.context.recentProductRef ? [input.context.recentProductRef.productId] : []),
  ]);

export type HumanIntentTurnDecisionRejectionReason =
  | 'schema_invalid'
  | 'continue_active_intent_mismatch'
  | 'continue_active_unknown_blocker'
  | 'continue_active_duplicate_blocker'
  | 'continue_active_fulfillment_mismatch'
  | 'resume_pending_unknown_id'
  | 'cancel_unknown_id'
  | 'replace_intent_mismatch'
  | 'replace_unknown_reference'
  | 'new_intent_unknown_reference'
  | 'new_intent_duplicate_proposal'
  | 'new_intent_duplicate_of_open';

interface HumanIntentTurnDecisionEvaluation {
  decision: HumanIntentPreflightDecision | null;
  rejectionReason: HumanIntentTurnDecisionRejectionReason | null;
}

const rejected = (
  rejectionReason: HumanIntentTurnDecisionRejectionReason
): HumanIntentTurnDecisionEvaluation => ({ decision: null, rejectionReason });

/**
 * Misma lógica de validación que antes; devuelve además un motivo tipado por
 * cada rechazo para poder distinguir en logs de diagnóstico si una decisión
 * `AMBIGUOUS` final vino del LLM o de esta validación (ver `runHumanIntentPreflight`).
 */
const evaluateHumanIntentTurnDecision = (
  value: unknown,
  input: HumanIntentPreflightInput
): HumanIntentTurnDecisionEvaluation => {
  const parsed = humanIntentTurnDecisionSchema.safeParse(value);
  if (!parsed.success) return rejected('schema_invalid');

  const decision = parsed.data;
  const open = openIntents(input);
  if (decision.decision === 'CONTINUE_ACTIVE') {
    if (decision.intentId !== input.state.active?.id) return rejected('continue_active_intent_mismatch');
    const blockerIds = new Set((input.state.active?.blockers ?? []).map((blocker) => blocker.id));
    if (decision.answeredBlockerIds.some((id) => !blockerIds.has(id))) {
      return rejected('continue_active_unknown_blocker');
    }
    if (new Set(decision.answeredBlockerIds).size !== decision.answeredBlockerIds.length) {
      return rejected('continue_active_duplicate_blocker');
    }
    if (decision.fulfillmentCandidate) {
      const goalType = decision.fulfillmentCandidate.goalType;
      if (
        goalType !== input.context.activeBlockingGoal ||
        !isIntentType(goalType) ||
        !getGoalFulfillmentContract(goalType)
      ) {
        return rejected('continue_active_fulfillment_mismatch');
      }
    }
  }
  if (decision.decision === 'RESUME_PENDING') {
    if (!input.state.pending.some((intent) => intent.id === decision.intentId)) {
      return rejected('resume_pending_unknown_id');
    }
  }
  if (decision.decision === 'CANCEL') {
    if (!open.some((intent) => intent.id === decision.intentId)) return rejected('cancel_unknown_id');
  }
  if (decision.decision === 'REPLACE') {
    if (decision.intentId !== input.state.active?.id) return rejected('replace_intent_mismatch');
    if (!requestContainsOnlyKnownIds(decision.replacement.request, knownIdsFor(input))) {
      return rejected('replace_unknown_reference');
    }
  }
  if (decision.decision === 'NEW_INTENT') {
    const proposalKeys = new Set<string>();
    const knownIds = knownIdsFor(input);
    for (const proposal of decision.intents) {
      if (!requestContainsOnlyKnownIds(proposal.request, knownIds)) {
        return rejected('new_intent_unknown_reference');
      }
      const key = `${proposal.goal}:${canonicalJson(proposal.request)}`;
      if (proposalKeys.has(key)) return rejected('new_intent_duplicate_proposal');
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
        return rejected('new_intent_duplicate_of_open');
      }
    }
  }
  return { decision, rejectionReason: null };
};

export const validateHumanIntentTurnDecision = (
  value: unknown,
  input: HumanIntentPreflightInput
): HumanIntentPreflightDecision | null => evaluateHumanIntentTurnDecision(value, input).decision;

const describeRawDecisionType = (value: unknown): string => {
  if (typeof value === 'object' && value !== null && 'decision' in value) {
    const raw = (value as { decision?: unknown }).decision;
    if (typeof raw === 'string') return raw;
  }
  return 'unrecognized';
};

const logPreflightDiagnostic = (event: Record<string, unknown>): void => {
  console.log(JSON.stringify({ event: '[human-intent-preflight] diagnostic', ...event }));
};

export const runHumanIntentPreflight = async (
  input: HumanIntentPreflightInput
): Promise<HumanIntentPreflightDecision> => {
  const { messageId } = input.turn;

  if (!input.turn.messageId.trim() || !input.turn.text.trim()) {
    logPreflightDiagnostic({ messageId, stage: 'empty_turn', finalDecision: 'AMBIGUOUS' });
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
    const rawDecisionType = describeRawDecisionType(result);
    const { decision, rejectionReason } = evaluateHumanIntentTurnDecision(result, input);
    const finalDecision = decision ?? { decision: 'AMBIGUOUS' as const };
    logPreflightDiagnostic({
      messageId,
      stage: 'validated',
      rawDecisionType,
      accepted: decision !== null,
      rejectionReason,
      finalDecision: finalDecision.decision,
    });
    return finalDecision;
  } catch (error) {
    console.error('[human-intent-preflight] classification failed:', error);
    logPreflightDiagnostic({ messageId, stage: 'llm_error', finalDecision: 'AMBIGUOUS' });
    return { decision: 'AMBIGUOUS' };
  }
};

export const isHumanGoal = (value: unknown): value is HumanGoal =>
  typeof value === 'string' && (HUMAN_GOALS as readonly string[]).includes(value);