import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export type HumanIntentStatus =
  | 'ACTIVE'
  | 'PENDING'
  | 'RESOLVED'
  | 'CANCELLED'
  | 'REPLACED';

export const HUMAN_GOALS = [
  'PEDIR',
  'EXPLORAR',
  'GESTIONAR_PEDIDO',
  'COMPLETAR_COMPRA',
  'CANCELAR_COMPRA',
  'SEGUIR_PEDIDO',
  'RESERVAR',
  'CONSULTAR_NEGOCIO',
  'SOPORTE_HUMANO',
] as const;

export type HumanGoal = (typeof HUMAN_GOALS)[number];

export interface HumanIntentBlocker {
  id: string;
  code: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface HumanIntentEffect {
  kind: string;
  reference?: string;
  occurredAt: string;
  success: true;
}

export interface HumanIntentRecord {
  id: string;
  sequence: number;
  goal: string;
  request: Record<string, unknown>;
  sourceMessageId?: string;
  status: HumanIntentStatus;
  blockers: HumanIntentBlocker[];
  createdAt: string;
  updatedAt: string;
  outcome?: HumanIntentEffect;
  replacedById?: string;
}

export interface HumanIntentStateV1 {
  version: 1;
  revision: number;
  nextSequence: number;
  processedMessageIds: string[];
  records: HumanIntentRecord[];
}

export interface CreateHumanIntentInput {
  goal: string;
  request: Record<string, unknown>;
  sourceMessageId?: string;
}

export interface AddHumanIntentBlockerInput {
  code: string;
  details?: Record<string, unknown>;
}

export type HumanIntentTurnDecision =
  | { decision: 'NO_INTENT' }
  | { decision: 'CONTINUE_ACTIVE'; intentId: string; answeredBlockerIds: string[] }
  | { decision: 'NEW_INTENT'; intents: Array<{ goal: HumanGoal; request: Record<string, unknown> }> }
  | { decision: 'RESUME_PENDING'; intentId: string }
  | { decision: 'CANCEL'; intentId: string }
  | {
      decision: 'REPLACE';
      intentId: string;
      replacement: { goal: HumanGoal; request: Record<string, unknown> };
    }
  | { decision: 'AMBIGUOUS' };

export type ApplyHumanIntentDecisionResult =
  | { status: 'applied'; state: HumanIntentStateV1 }
  | { status: 'duplicate'; state: HumanIntentStateV1 }
  | { status: 'stale'; state: HumanIntentStateV1 }
  | { status: 'ambiguous'; state: HumanIntentStateV1 };

export class HumanIntentStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HumanIntentStateError';
  }
}

const EMPTY_STATE = (): HumanIntentStateV1 => ({
  version: 1,
  revision: 0,
  nextSequence: 1,
  processedMessageIds: [],
  records: [],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const cloneJsonObject = (
  value: Record<string, unknown>,
  label: string
): Record<string, unknown> => {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new HumanIntentStateError(`${label} must be JSON serializable`);
  }
  if (serialized === undefined) {
    throw new HumanIntentStateError(`${label} must be JSON serializable`);
  }
  return JSON.parse(serialized) as Record<string, unknown>;
};

const isStatus = (value: unknown): value is HumanIntentStatus =>
  value === 'ACTIVE' ||
  value === 'PENDING' ||
  value === 'RESOLVED' ||
  value === 'CANCELLED' ||
  value === 'REPLACED';

const assertValidState = (state: HumanIntentStateV1): void => {
  if (
    state.version !== 1 ||
    !Number.isInteger(state.revision) ||
    state.revision < 0 ||
    !Number.isInteger(state.nextSequence) ||
    state.nextSequence < 1 ||
    !Array.isArray(state.processedMessageIds)
  ) {
    throw new HumanIntentStateError('Invalid HumanIntentStateV1 header');
  }

  const ids = new Set<string>();
  const sequences = new Set<number>();
  let activeCount = 0;
  let maxSequence = 0;

  for (const intent of state.records) {
    if (!intent.id || ids.has(intent.id)) {
      throw new HumanIntentStateError('Human intent ids must be present and unique');
    }
    if (!Number.isInteger(intent.sequence) || intent.sequence < 1 || sequences.has(intent.sequence)) {
      throw new HumanIntentStateError('Human intent sequences must be positive and unique');
    }
    if (!isStatus(intent.status)) {
      throw new HumanIntentStateError(`Invalid human intent status: ${String(intent.status)}`);
    }
    if (!isRecord(intent.request) || !Array.isArray(intent.blockers)) {
      throw new HumanIntentStateError(`Invalid human intent record: ${intent.id}`);
    }
    if (intent.status === 'ACTIVE') activeCount += 1;
    ids.add(intent.id);
    sequences.add(intent.sequence);
    maxSequence = Math.max(maxSequence, intent.sequence);
  }

  if (activeCount > 1) {
    throw new HumanIntentStateError('At most one human intent may be ACTIVE');
  }
  if (state.nextSequence <= maxSequence) {
    throw new HumanIntentStateError('nextSequence must be greater than every assigned sequence');
  }
};

const parseState = (value: unknown): HumanIntentStateV1 => {
  if (value == null) return EMPTY_STATE();
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) {
    throw new HumanIntentStateError('Stored humanIntentState is not a supported V1 value');
  }

  const state = {
    ...value,
    revision:
      Number.isInteger(value.revision) && Number(value.revision) >= 0
        ? Number(value.revision)
        : 0,
    processedMessageIds: Array.isArray(value.processedMessageIds)
      ? value.processedMessageIds.filter((id): id is string => typeof id === 'string')
      : [],
  } as unknown as HumanIntentStateV1;
  assertValidState(state);
  return state;
};

const metadataRecord = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : {};

const activeIndex = (state: HumanIntentStateV1): number =>
  state.records.findIndex((intent) => intent.status === 'ACTIVE');

const indexById = (state: HumanIntentStateV1, intentId: string): number => {
  const index = state.records.findIndex((intent) => intent.id === intentId);
  if (index < 0) throw new HumanIntentStateError(`Unknown human intent: ${intentId}`);
  return index;
};

const requireOpenIntent = (state: HumanIntentStateV1, intentId: string): number => {
  const index = indexById(state, intentId);
  const status = state.records[index].status;
  if (status !== 'ACTIVE' && status !== 'PENDING') {
    throw new HumanIntentStateError(`Human intent ${intentId} is already terminal`);
  }
  return index;
};

const promoteOldestPending = (state: HumanIntentStateV1, now: string): void => {
  if (activeIndex(state) >= 0) return;
  const next = state.records
    .map((intent, index) => ({ intent, index }))
    .filter(({ intent }) => intent.status === 'PENDING')
    .sort((a, b) => a.intent.sequence - b.intent.sequence)[0];
  if (!next) return;
  state.records[next.index] = {
    ...next.intent,
    status: 'ACTIVE',
    updatedAt: now,
  };
};

const newRecord = (
  state: HumanIntentStateV1,
  input: CreateHumanIntentInput,
  status: 'ACTIVE' | 'PENDING',
  now: string
): HumanIntentRecord => {
  const goal = input.goal.trim();
  if (!goal) throw new HumanIntentStateError('Human intent goal cannot be empty');
  if (!isRecord(input.request)) {
    throw new HumanIntentStateError('Human intent request must be an object');
  }

  return {
    id: randomUUID(),
    sequence: state.nextSequence,
    goal,
    request: cloneJsonObject(input.request, 'Human intent request'),
    ...(input.sourceMessageId?.trim()
      ? { sourceMessageId: input.sourceMessageId.trim() }
      : {}),
    status,
    blockers: [],
    createdAt: now,
    updatedAt: now,
  };
};

type StateMutation<T> = (state: HumanIntentStateV1) => T;

/**
 * Serializes lifecycle writes with a transaction-scoped per-conversation lock.
 * jsonb_set changes only this key; unrelated metadata keys are not rewritten here.
 * Legacy writers that replace the full metadata JSON do not take this lock and
 * may still overwrite this key if they race with a stale snapshot.
 */
const mutateState = async <T>(
  conversationId: string,
  mutation: StateMutation<T>
): Promise<T> => {
  if (!conversationId.trim()) throw new HumanIntentStateError('conversationId is required');

  await prisma.conversation_state.upsert({
    where: { conversation_id: conversationId },
    update: {},
    create: { conversation_id: conversationId },
  });

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${`human-intent:${conversationId}`}))
    `;

    const row = await tx.conversation_state.findUnique({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const metadata = metadataRecord(row?.metadata);
    const state = parseState(metadata.humanIntentState);
    const previousState = JSON.stringify(state);
    const result = mutation(state);
    if (JSON.stringify(state) !== previousState) state.revision += 1;
    assertValidState(state);

    if (JSON.stringify(state) === previousState) return result;

    const updated = await tx.$executeRaw`
      UPDATE conversation_state
      SET metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{humanIntentState}',
            ${JSON.stringify(state)}::jsonb,
            true
          ),
          updated_at = NOW()
      WHERE conversation_id = ${conversationId}::uuid
    `;
    if (updated !== 1) {
      throw new HumanIntentStateError(`Could not persist human intents for ${conversationId}`);
    }
    return result;
  });
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

export const mergeEquivalentPedirRequest = (
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): Record<string, unknown> | null => {
  if (canonicalJson(existing) === canonicalJson(incoming)) return { ...existing };
  if (Object.keys(existing).length === 0) return cloneJsonObject(incoming, 'Intent request');
  if (Object.keys(incoming).length === 0) return { ...existing };

  const existingProducts = existing.products;
  const incomingProducts = incoming.products;
  if (
    !Array.isArray(existingProducts) ||
    !Array.isArray(incomingProducts) ||
    !existingProducts.every((product) => typeof product === 'string') ||
    !incomingProducts.every((product) => typeof product === 'string')
  ) {
    return null;
  }

  const { products: _existingProducts, ...existingDetails } = existing;
  const { products: _incomingProducts, ...incomingDetails } = incoming;
  if (canonicalJson(existingDetails) !== canonicalJson(incomingDetails)) return null;

  const existingSet = new Set(existingProducts as string[]);
  const incomingSet = new Set(incomingProducts as string[]);
  const isSubset = (subset: Set<string>, superset: Set<string>): boolean =>
    [...subset].every((product) => superset.has(product));
  if (!isSubset(existingSet, incomingSet) && !isSubset(incomingSet, existingSet)) return null;

  return {
    ...existing,
    ...incoming,
    products: [...new Set([...existingProducts, ...incomingProducts])],
  };
};

const assertHumanGoal = (value: string): value is HumanGoal =>
  (HUMAN_GOALS as readonly string[]).includes(value);

/** Applies one preflight result as a single locked, revision-checked mutation. */
export const applyHumanIntentTurnDecision = (params: {
  conversationId: string;
  messageId: string;
  expectedRevision: number;
  decision: HumanIntentTurnDecision;
}): Promise<ApplyHumanIntentDecisionResult> =>
  mutateState(params.conversationId, (state) => {
    const messageId = params.messageId.trim();
    if (!messageId) throw new HumanIntentStateError('messageId is required for preflight');
    if (state.processedMessageIds.includes(messageId)) {
      return { status: 'duplicate', state };
    }
    if (state.revision !== params.expectedRevision) {
      return { status: 'stale', state };
    }
    if (params.decision.decision === 'AMBIGUOUS') {
      return { status: 'ambiguous', state };
    }

    const now = new Date().toISOString();
    const currentIndex = activeIndex(state);
    const current = currentIndex >= 0 ? state.records[currentIndex] : null;
    const findOpenIntent = (intentId: string): number => {
      const index = requireOpenIntent(state, intentId);
      return index;
    };

    switch (params.decision.decision) {
      case 'NO_INTENT':
        break;
      case 'CONTINUE_ACTIVE': {
        if (!current || current.id !== params.decision.intentId) {
          throw new HumanIntentStateError('CONTINUE_ACTIVE must target the current ACTIVE intent');
        }
        const blockerIds = new Set(current.blockers.map((blocker) => blocker.id));
        if (params.decision.answeredBlockerIds.some((id) => !blockerIds.has(id))) {
          throw new HumanIntentStateError('CONTINUE_ACTIVE referenced an unknown blocker');
        }
        break;
      }
      case 'NEW_INTENT': {
        if (params.decision.intents.length === 0 || params.decision.intents.length > 8) {
          throw new HumanIntentStateError('NEW_INTENT requires between 1 and 8 goals');
        }
        const proposals = params.decision.intents.map((item) => {
          if (!assertHumanGoal(item.goal) || !isRecord(item.request)) {
            throw new HumanIntentStateError('NEW_INTENT contains an invalid goal or request');
          }
          return { goal: item.goal, request: cloneJsonObject(item.request, 'Intent request') };
        });
        const seen = new Set<string>();
        for (const proposal of proposals) {
          const key = `${proposal.goal}:${canonicalJson(proposal.request)}`;
          if (seen.has(key)) throw new HumanIntentStateError('NEW_INTENT contains duplicate goals');
          seen.add(key);
        }

        const candidateIndices = [
          ...(currentIndex >= 0 ? [currentIndex] : []),
          ...state.records.map((_, index) => index).filter((index) => index !== currentIndex),
        ];
        const matchedProposalIndices = new Set<number>();
        const matchedIntentIndices = new Set<number>();
        for (const [proposalIndex, proposal] of proposals.entries()) {
          if (proposal.goal !== 'PEDIR') continue;
          const matchingIndex = candidateIndices.find((index) => {
            const record = state.records[index];
            return (
              (record.status === 'ACTIVE' || record.status === 'PENDING') &&
              record.goal === 'PEDIR' &&
              mergeEquivalentPedirRequest(record.request, proposal.request) !== null
            );
          });
          if (matchingIndex === undefined) continue;

          const record = state.records[matchingIndex];
          const mergedRequest = mergeEquivalentPedirRequest(record.request, proposal.request)!;
          if (canonicalJson(record.request) !== canonicalJson(mergedRequest)) {
            state.records[matchingIndex] = { ...record, request: mergedRequest, updatedAt: now };
          }
          matchedProposalIndices.add(proposalIndex);
          matchedIntentIndices.add(matchingIndex);
        }

        const additions = proposals.filter((_, index) => !matchedProposalIndices.has(index));
        const currentMatched = currentIndex >= 0 && matchedIntentIndices.has(currentIndex);
        if (additions.length > 0 && currentIndex >= 0 && !currentMatched) {
          state.records[currentIndex] = {
            ...state.records[currentIndex],
            status: 'PENDING',
            updatedAt: now,
          };
        }
        for (const [index, proposal] of additions.entries()) {
          const intent = newRecord(
            state,
            { ...proposal, sourceMessageId: messageId },
            currentMatched || index > 0 ? 'PENDING' : 'ACTIVE',
            now
          );
          state.nextSequence += 1;
          state.records.push(intent);
        }
        break;
      }
      case 'RESUME_PENDING': {
        const targetIndex = findOpenIntent(params.decision.intentId);
        if (state.records[targetIndex].status !== 'PENDING') {
          throw new HumanIntentStateError('RESUME_PENDING must target a PENDING intent');
        }
        if (currentIndex >= 0) {
          state.records[currentIndex] = {
            ...state.records[currentIndex],
            status: 'PENDING',
            updatedAt: now,
          };
        }
        state.records[targetIndex] = {
          ...state.records[targetIndex],
          status: 'ACTIVE',
          updatedAt: now,
        };
        break;
      }
      case 'CANCEL': {
        const targetIndex = findOpenIntent(params.decision.intentId);
        const wasActive = state.records[targetIndex].status === 'ACTIVE';
        state.records[targetIndex] = {
          ...state.records[targetIndex],
          status: 'CANCELLED',
          blockers: [],
          updatedAt: now,
        };
        if (wasActive) promoteOldestPending(state, now);
        break;
      }
      case 'REPLACE': {
        if (!current || current.id !== params.decision.intentId) {
          throw new HumanIntentStateError('REPLACE must target the current ACTIVE intent');
        }
        const replacement = params.decision.replacement;
        if (!assertHumanGoal(replacement.goal) || !isRecord(replacement.request)) {
          throw new HumanIntentStateError('REPLACE contains an invalid goal or request');
        }
        const next = newRecord(
          state,
          {
            ...replacement,
            request: cloneJsonObject(replacement.request, 'Replacement request'),
            sourceMessageId: messageId,
          },
          'ACTIVE',
          now
        );
        state.nextSequence += 1;
        state.records[currentIndex] = {
          ...current,
          status: 'REPLACED',
          blockers: [],
          replacedById: next.id,
          updatedAt: now,
        };
        state.records.push(next);
        break;
      }
      default: {
        const exhaustive: never = params.decision;
        throw new HumanIntentStateError(`Unsupported decision: ${String(exhaustive)}`);
      }
    }

    state.processedMessageIds.push(messageId);
    return { status: 'applied', state };
  });

const readState = async (conversationId: string): Promise<HumanIntentStateV1> => {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  return parseState(metadataRecord(row?.metadata).humanIntentState);
};

/** Creates an independent intention as ACTIVE and suspends the previous ACTIVE. */
export const createHumanIntent = (
  conversationId: string,
  input: CreateHumanIntentInput
): Promise<HumanIntentRecord> =>
  mutateState(conversationId, (state) => {
    const now = new Date().toISOString();
    const current = activeIndex(state);
    if (current >= 0) {
      state.records[current] = {
        ...state.records[current],
        status: 'PENDING',
        updatedAt: now,
      };
    }
    const intent = newRecord(state, input, 'ACTIVE', now);
    state.nextSequence += 1;
    state.records.push(intent);
    return intent;
  });

/** Appends an intention as PENDING, for ordered siblings from the same turn. */
export const createPendingHumanIntent = (
  conversationId: string,
  input: CreateHumanIntentInput
): Promise<HumanIntentRecord> =>
  mutateState(conversationId, (state) => {
    const now = new Date().toISOString();
    if (activeIndex(state) < 0) promoteOldestPending(state, now);
    const status = activeIndex(state) < 0 ? 'ACTIVE' : 'PENDING';
    const intent = newRecord(state, input, status, now);
    state.nextSequence += 1;
    state.records.push(intent);
    return intent;
  });

export const activateHumanIntent = (
  conversationId: string,
  intentId: string
): Promise<HumanIntentRecord> =>
  mutateState(conversationId, (state) => {
    const targetIndex = requireOpenIntent(state, intentId);
    const target = state.records[targetIndex];
    if (target.status === 'ACTIVE') return target;

    const current = activeIndex(state);
    const now = new Date().toISOString();
    if (current >= 0) {
      state.records[current] = {
        ...state.records[current],
        status: 'PENDING',
        updatedAt: now,
      };
    }
    const activated = { ...target, status: 'ACTIVE' as const, updatedAt: now };
    state.records[targetIndex] = activated;
    return activated;
  });

export const suspendActiveHumanIntent = (
  conversationId: string
): Promise<HumanIntentRecord | null> =>
  mutateState(conversationId, (state) => {
    const index = activeIndex(state);
    if (index < 0) return null;
    const suspended = {
      ...state.records[index],
      status: 'PENDING' as const,
      updatedAt: new Date().toISOString(),
    };
    state.records[index] = suspended;
    return suspended;
  });

export const resolveActiveHumanIntent = (
  conversationId: string,
  effect: HumanIntentEffect
): Promise<HumanIntentRecord> =>
  mutateState(conversationId, (state) => {
    if (effect.success !== true || !effect.kind.trim() || !Number.isFinite(Date.parse(effect.occurredAt))) {
      throw new HumanIntentStateError('Resolution requires a validated successful effect');
    }
    const index = activeIndex(state);
    if (index < 0) throw new HumanIntentStateError('There is no ACTIVE human intent to resolve');
    const resolved: HumanIntentRecord = {
      ...state.records[index],
      status: 'RESOLVED',
      blockers: [],
      outcome: { ...effect },
      updatedAt: new Date().toISOString(),
    };
    state.records[index] = resolved;
    promoteOldestPending(state, resolved.updatedAt);
    return resolved;
  });

export const cancelHumanIntent = (
  conversationId: string,
  intentId: string
): Promise<HumanIntentRecord> =>
  mutateState(conversationId, (state) => {
    const index = requireOpenIntent(state, intentId);
    const wasActive = state.records[index].status === 'ACTIVE';
    const cancelled: HumanIntentRecord = {
      ...state.records[index],
      status: 'CANCELLED',
      blockers: [],
      updatedAt: new Date().toISOString(),
    };
    state.records[index] = cancelled;
    if (wasActive) promoteOldestPending(state, cancelled.updatedAt);
    return cancelled;
  });

export const replaceHumanIntent = (
  conversationId: string,
  intentId: string,
  replacement: CreateHumanIntentInput
): Promise<{ replaced: HumanIntentRecord; replacement: HumanIntentRecord }> =>
  mutateState(conversationId, (state) => {
    const index = requireOpenIntent(state, intentId);
    const previous = state.records[index];
    const wasActive = previous.status === 'ACTIVE';
    const now = new Date().toISOString();
    const next = newRecord(state, replacement, wasActive ? 'ACTIVE' : 'PENDING', now);
    state.nextSequence += 1;
    state.records[index] = {
      ...previous,
      status: 'REPLACED',
      blockers: [],
      replacedById: next.id,
      updatedAt: now,
    };
    state.records.push(next);
    return { replaced: state.records[index], replacement: next };
  });

export const addHumanIntentBlocker = (
  conversationId: string,
  intentId: string,
  input: AddHumanIntentBlockerInput
): Promise<HumanIntentRecord> =>
  mutateState(conversationId, (state) => {
    const index = requireOpenIntent(state, intentId);
    const code = input.code.trim();
    if (!code) throw new HumanIntentStateError('Blocker code cannot be empty');
    const intent = state.records[index];
    const blocker: HumanIntentBlocker = {
      id: randomUUID(),
      code,
      ...(input.details ? { details: cloneJsonObject(input.details, 'Blocker details') } : {}),
      createdAt: new Date().toISOString(),
    };
    const updated = {
      ...intent,
      blockers: [...intent.blockers, blocker],
      updatedAt: blocker.createdAt,
    };
    state.records[index] = updated;
    return updated;
  });

export const removeHumanIntentBlocker = (
  conversationId: string,
  intentId: string,
  blockerId: string
): Promise<HumanIntentRecord> =>
  mutateState(conversationId, (state) => {
    const index = requireOpenIntent(state, intentId);
    const intent = state.records[index];
    const blockers = intent.blockers.filter((blocker) => blocker.id !== blockerId);
    if (blockers.length === intent.blockers.length) return intent;
    const updated = { ...intent, blockers, updatedAt: new Date().toISOString() };
    state.records[index] = updated;
    return updated;
  });

export const getHumanIntentState = (conversationId: string): Promise<HumanIntentStateV1> =>
  readState(conversationId);

export const getActiveHumanIntent = async (
  conversationId: string
): Promise<HumanIntentRecord | null> => {
  const state = await readState(conversationId);
  return state.records.find((intent) => intent.status === 'ACTIVE') ?? null;
};

export const getPendingHumanIntents = async (
  conversationId: string
): Promise<HumanIntentRecord[]> => {
  const state = await readState(conversationId);
  return state.records
    .filter((intent) => intent.status === 'PENDING')
    .sort((a, b) => a.sequence - b.sequence);
};