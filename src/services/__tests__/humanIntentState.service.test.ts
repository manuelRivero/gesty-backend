import { beforeEach, describe, expect, it, vi } from 'vitest';

const { prismaMock, stateStore } = vi.hoisted(() => {
  const store: { metadata: Record<string, unknown> | null } = { metadata: {} };
  const prisma = {
    conversation_state: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return { prismaMock: prisma, stateStore: store };
});

vi.mock('../../lib/prisma', () => ({ prisma: prismaMock }));

import {
  applyHumanIntentTurnDecision,
  activateHumanIntent,
  addHumanIntentBlocker,
  cancelHumanIntent,
  createHumanIntent,
  createPendingHumanIntent,
  getActiveHumanIntent,
  getHumanIntentState,
  getPendingHumanIntents,
  removeHumanIntentBlocker,
  replaceHumanIntent,
  resolveActiveHumanIntent,
  suspendActiveHumanIntent,
} from '../humanIntentState.service';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const EFFECT = {
  kind: 'cart_item_written',
  reference: 'draft-item-1',
  occurredAt: '2026-09-27T12:00:00.000Z',
  success: true as const,
};

const input = (goal: string) => ({
  goal,
  request: { product: goal.toLowerCase() },
});

describe('humanIntentState V1', () => {
  let advisoryTails: Map<string, Promise<void>>;
  let advisoryLockCalls: number;

  beforeEach(() => {
    vi.clearAllMocks();
    stateStore.metadata = {};
    advisoryTails = new Map();
    advisoryLockCalls = 0;

    prismaMock.conversation_state.upsert.mockImplementation(async () => ({}));
    prismaMock.conversation_state.findUnique.mockImplementation(async () => ({
      metadata: stateStore.metadata,
    }));
    prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      const releases: Array<() => void> = [];
      const tx = {
        conversation_state: prismaMock.conversation_state,
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join(' ').toLowerCase();
          if (sql.includes('pg_advisory_xact_lock')) {
            advisoryLockCalls += 1;
            const key = String(values[0]);
            const previous = advisoryTails.get(key) ?? Promise.resolve();
            let release!: () => void;
            const gate = new Promise<void>((resolve) => {
              release = resolve;
            });
            advisoryTails.set(key, previous.then(() => gate));
            await previous;
            releases.push(release);
            return 0;
          }
          return prismaMock.$executeRaw(strings, ...values);
        },
      };
      try {
        return await callback(tx);
      } finally {
        for (const release of releases.reverse()) release();
      }
    });
    prismaMock.$executeRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(' ').toLowerCase();
      if (sql.includes('jsonb_set')) {
        const [serializedState] = values;
        const metadata =
          stateStore.metadata && typeof stateStore.metadata === 'object'
            ? stateStore.metadata
            : {};
        stateStore.metadata = {
          ...metadata,
          humanIntentState: JSON.parse(String(serializedState)),
        };
        return 1;
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
  });

  it('crea la primera intención como ACTIVE', async () => {
    const created = await createHumanIntent(CONVERSATION_ID, input('PEDIR_CEVICHE'));

    expect(created.status).toBe('ACTIVE');
    expect(created.sequence).toBe(1);
    expect(await getActiveHumanIntent(CONVERSATION_ID)).toMatchObject({ id: created.id });
  });

  it('una nueva intención activa suspende la anterior como PENDING', async () => {
    const first = await createHumanIntent(CONVERSATION_ID, input('PEDIR_CEVICHE'));
    const second = await createHumanIntent(CONVERSATION_ID, input('CONSULTAR_DELIVERY'));
    const state = await getHumanIntentState(CONVERSATION_ID);

    expect(state.records.find(({ id }) => id === first.id)?.status).toBe('PENDING');
    expect(second.status).toBe('ACTIVE');
  });

  it('mantiene las PENDING ordenadas por sequence', async () => {
    const a = await createHumanIntent(CONVERSATION_ID, input('A'));
    const b = await createPendingHumanIntent(CONVERSATION_ID, input('B'));
    const c = await createPendingHumanIntent(CONVERSATION_ID, input('C'));
    await createHumanIntent(CONVERSATION_ID, input('D'));

    expect((await getPendingHumanIntents(CONVERSATION_ID)).map(({ id }) => id)).toEqual([
      a.id,
      b.id,
      c.id,
    ]);
  });

  it('resolver ACTIVE promueve la PENDING más antigua', async () => {
    const first = await createHumanIntent(CONVERSATION_ID, input('A'));
    const second = await createPendingHumanIntent(CONVERSATION_ID, input('B'));
    await createPendingHumanIntent(CONVERSATION_ID, input('C'));

    const resolved = await resolveActiveHumanIntent(CONVERSATION_ID, EFFECT);

    expect(resolved).toMatchObject({ id: first.id, status: 'RESOLVED', outcome: EFFECT });
    expect(await getActiveHumanIntent(CONVERSATION_ID)).toMatchObject({
      id: second.id,
      status: 'ACTIVE',
    });
  });

  it('rechaza resolver con un efecto fallido', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, input('A'));

    await expect(
      resolveActiveHumanIntent(CONVERSATION_ID, {
        ...EFFECT,
        success: false,
      } as never)
    ).rejects.toThrow(/validated successful effect/i);
    expect(await getActiveHumanIntent(CONVERSATION_ID)).toMatchObject({
      id: active.id,
      status: 'ACTIVE',
    });
  });

  it('cancelar ACTIVE promueve la PENDING más antigua', async () => {
    await createHumanIntent(CONVERSATION_ID, input('A'));
    const second = await createPendingHumanIntent(CONVERSATION_ID, input('B'));

    const cancelled = await cancelHumanIntent(
      CONVERSATION_ID,
      (await getActiveHumanIntent(CONVERSATION_ID))!.id
    );

    expect(cancelled.status).toBe('CANCELLED');
    expect(await getActiveHumanIntent(CONVERSATION_ID)).toMatchObject({
      id: second.id,
      status: 'ACTIVE',
    });
  });

  it('agregar o quitar un blocker no cambia el estado ACTIVE', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, input('PEDIR_CEVICHE'));
    const blocked = await addHumanIntentBlocker(CONVERSATION_ID, active.id, {
      code: 'PARTY_SIZE_REQUIRED',
      details: { question: '¿Para cuántas personas?' },
    });
    const cleared = await removeHumanIntentBlocker(
      CONVERSATION_ID,
      active.id,
      blocked.blockers[0].id
    );

    expect(blocked.status).toBe('ACTIVE');
    expect(blocked.blockers).toHaveLength(1);
    expect(cleared.status).toBe('ACTIVE');
    expect(cleared.blockers).toHaveLength(0);
  });

  it('reemplazar marca la anterior REPLACED y activa la corrección', async () => {
    const original = await createHumanIntent(CONVERSATION_ID, input('PEDIR_MILANESA'));
    const result = await replaceHumanIntent(
      CONVERSATION_ID,
      original.id,
      input('PEDIR_HAMBURGUESA')
    );

    expect(result.replaced).toMatchObject({
      id: original.id,
      status: 'REPLACED',
      replacedById: result.replacement.id,
    });
    expect(result.replacement).toMatchObject({ status: 'ACTIVE', sequence: 2 });
  });

  it('crear una intención normal no reemplaza la activa', async () => {
    const original = await createHumanIntent(CONVERSATION_ID, input('PEDIR_MILANESA'));
    const next = await createHumanIntent(CONVERSATION_ID, input('CONSULTAR_DELIVERY'));
    const state = await getHumanIntentState(CONVERSATION_ID);

    expect(state.records.find(({ id }) => id === original.id)?.status).toBe('PENDING');
    expect(state.records.find(({ id }) => id === next.id)?.status).toBe('ACTIVE');
    expect(state.records.find(({ id }) => id === original.id)?.status).not.toBe('REPLACED');
  });

  it('activar una PENDING suspende la anterior y nunca deja dos ACTIVE', async () => {
    const first = await createHumanIntent(CONVERSATION_ID, input('A'));
    const second = await createPendingHumanIntent(CONVERSATION_ID, input('B'));

    await activateHumanIntent(CONVERSATION_ID, second.id);
    const state = await getHumanIntentState(CONVERSATION_ID);

    expect(state.records.filter(({ status }) => status === 'ACTIVE')).toHaveLength(1);
    expect(state.records.find(({ id }) => id === first.id)?.status).toBe('PENDING');
  });

  it('suspender no promueve otra intención implícitamente', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, input('A'));
    const pending = await createPendingHumanIntent(CONVERSATION_ID, input('B'));

    await suspendActiveHumanIntent(CONVERSATION_ID);

    expect(await getActiveHumanIntent(CONVERSATION_ID)).toBeNull();
    expect((await getPendingHumanIntents(CONVERSATION_ID)).map(({ id }) => id)).toEqual([
      active.id,
      pending.id,
    ]);
  });

  it('serializa creaciones concurrentes sin duplicar sequence ni ACTIVE', async () => {
    const created = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        createHumanIntent(CONVERSATION_ID, input(`INTENT_${index}`))
      )
    );
    const state = await getHumanIntentState(CONVERSATION_ID);
    const sequences = state.records.map(({ sequence }) => sequence).sort((a, b) => a - b);

    expect(created).toHaveLength(10);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(new Set(sequences).size).toBe(10);
    expect(state.records.filter(({ status }) => status === 'ACTIVE')).toHaveLength(1);
    expect(advisoryLockCalls).toBe(10);
  });

  it('conserva intacta la metadata legacy', async () => {
    stateStore.metadata = {
      checkout_active: true,
      pendingPartySizeOrder: { source: 'lookup', summary: 'ceviche' },
      intentLedger: { COMPLETAR_PEDIDO: { surfaceCount: 1 } },
    };

    await createHumanIntent(CONVERSATION_ID, input('PEDIR_CEVICHE'));

    expect(stateStore.metadata).toMatchObject({
      checkout_active: true,
      pendingPartySizeOrder: { source: 'lookup', summary: 'ceviche' },
      intentLedger: { COMPLETAR_PEDIDO: { surfaceCount: 1 } },
    });
    expect(stateStore.metadata?.humanIntentState).toBeDefined();
  });

  it('persiste y reconstruye HumanIntentStateV1 en round-trip', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, input('PEDIR_CEVICHE'));
    await createPendingHumanIntent(CONVERSATION_ID, input('CONSULTAR_DELIVERY'));
    await addHumanIntentBlocker(CONVERSATION_ID, active.id, { code: 'PARTY_SIZE_REQUIRED' });

    const loaded = await getHumanIntentState(CONVERSATION_ID);

    expect(loaded).toMatchObject({ version: 1, nextSequence: 3 });
    expect(loaded.records).toHaveLength(2);
    expect(loaded.records[0]).toMatchObject({
      id: active.id,
      status: 'ACTIVE',
      blockers: [{ code: 'PARTY_SIZE_REQUIRED' }],
    });
    expect(loaded.records[1]).toMatchObject({ status: 'PENDING', sequence: 2 });
  });

  const applyDecision = async (
    messageId: string,
    decision: Parameters<typeof applyHumanIntentTurnDecision>[0]['decision'],
    expectedRevision?: number
  ) => {
    const state = await getHumanIntentState(CONVERSATION_ID);
    return applyHumanIntentTurnDecision({
      conversationId: CONVERSATION_ID,
      messageId,
      expectedRevision: expectedRevision ?? state.revision,
      decision,
    });
  };

  it('NEW_INTENT sin ACTIVE crea la nueva como ACTIVE', async () => {
    const result = await applyDecision('turn-new-1', {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'PEDIR', request: { products: ['ceviche'] } }],
    });

    expect(result.status).toBe('applied');
    expect(await getActiveHumanIntent(CONVERSATION_ID)).toMatchObject({
      goal: 'PEDIR',
      request: { products: ['ceviche'] },
      status: 'ACTIVE',
      sourceMessageId: 'turn-new-1',
    });
  });

  it('NEW_INTENT suspende ACTIVE sin destruirla', async () => {
    const original = await createHumanIntent(CONVERSATION_ID, input('PEDIR'));
    await applyDecision('turn-new-2', {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'CONSULTAR_NEGOCIO', request: { subject: 'delivery' } }],
    });

    const state = await getHumanIntentState(CONVERSATION_ID);
    expect(state.records.find(({ id }) => id === original.id)?.status).toBe('PENDING');
    expect(state.records.filter(({ status }) => status === 'ACTIVE')).toHaveLength(1);
    expect(state.records.find(({ status }) => status === 'ACTIVE')?.goal).toBe('CONSULTAR_NEGOCIO');
  });

  it('respuesta a blocker conserva ACTIVE y el blocker intacto', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, input('PEDIR'));
    const blocked = await addHumanIntentBlocker(CONVERSATION_ID, active.id, {
      code: 'PARTY_SIZE_REQUIRED',
    });

    await applyDecision('turn-party-size', {
      decision: 'CONTINUE_ACTIVE',
      intentId: active.id,
      answeredBlockerIds: [blocked.blockers[0].id],
    });

    expect(await getActiveHumanIntent(CONVERSATION_ID)).toMatchObject({
      id: active.id,
      status: 'ACTIVE',
      blockers: [{ id: blocked.blockers[0].id, code: 'PARTY_SIZE_REQUIRED' }],
    });
  });

  it('nueva intención deja el blocker de la anterior intacto en PENDING', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, input('PEDIR'));
    const blocked = await addHumanIntentBlocker(CONVERSATION_ID, active.id, {
      code: 'PARTY_SIZE_REQUIRED',
    });

    await applyDecision('turn-independent', {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'EXPLORAR', request: { category: 'postres' } }],
    });

    const state = await getHumanIntentState(CONVERSATION_ID);
    expect(state.records.find(({ id }) => id === active.id)).toMatchObject({
      status: 'PENDING',
      blockers: [{ id: blocked.blockers[0].id }],
    });
  });

  it('RESUME_PENDING activa el ID existente y conserva el resto de la cola', async () => {
    await createHumanIntent(CONVERSATION_ID, input('CONSULTAR_NEGOCIO'));
    const postres = await createPendingHumanIntent(CONVERSATION_ID, {
      goal: 'EXPLORAR', request: { category: 'postres' },
    });
    const bebidas = await createPendingHumanIntent(CONVERSATION_ID, {
      goal: 'EXPLORAR', request: { category: 'bebidas' },
    });

    await applyDecision('turn-resume', { decision: 'RESUME_PENDING', intentId: postres.id });

    const state = await getHumanIntentState(CONVERSATION_ID);
    expect(state.records.find(({ id }) => id === postres.id)?.status).toBe('ACTIVE');
    expect(state.records.find(({ id }) => id === bebidas.id)?.status).toBe('PENDING');
    expect(state.records).toHaveLength(3);
  });

  it('REPLACE reemplaza solo ACTIVE y mantiene CANCEL distinto', async () => {
    const original = await createHumanIntent(CONVERSATION_ID, input('PEDIR'));
    const result = await applyDecision('turn-replace', {
      decision: 'REPLACE',
      intentId: original.id,
      replacement: { goal: 'PEDIR', request: { products: ['hamburguesa'] } },
    });

    expect(result.status).toBe('applied');
    const state = await getHumanIntentState(CONVERSATION_ID);
    expect(state.records.find(({ id }) => id === original.id)?.status).toBe('REPLACED');
    expect(state.records.filter(({ status }) => status === 'CANCELLED')).toHaveLength(0);
    expect(state.records.find(({ status }) => status === 'ACTIVE')?.request).toEqual({
      products: ['hamburguesa'],
    });
  });

  it('CANCEL cancela el ID correcto y promueve PENDING', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, input('PEDIR'));
    const pending = await createPendingHumanIntent(CONVERSATION_ID, {
      goal: 'EXPLORAR', request: { category: 'postres' },
    });

    await applyDecision('turn-cancel', { decision: 'CANCEL', intentId: active.id });

    const state = await getHumanIntentState(CONVERSATION_ID);
    expect(state.records.find(({ id }) => id === active.id)?.status).toBe('CANCELLED');
    expect(state.records.find(({ id }) => id === pending.id)?.status).toBe('ACTIVE');
  });

  it('AMBIGUOUS no modifica records ni revision', async () => {
    await createHumanIntent(CONVERSATION_ID, input('PEDIR'));
    const before = await getHumanIntentState(CONVERSATION_ID);
    const result = await applyDecision('turn-ambiguous', { decision: 'AMBIGUOUS' });
    const after = await getHumanIntentState(CONVERSATION_ID);

    expect(result.status).toBe('ambiguous');
    expect(after).toEqual(before);
  });

  it('multi-intent aplica ACTIVE y PENDING en orden dentro de una transición', async () => {
    await applyDecision('turn-multi', {
      decision: 'NEW_INTENT',
      intents: [
        { goal: 'PEDIR', request: { products: ['ceviche'] } },
        { goal: 'EXPLORAR', request: { category: 'postres' } },
        { goal: 'EXPLORAR', request: { category: 'bebidas' } },
      ],
    });

    const state = await getHumanIntentState(CONVERSATION_ID);
    expect(state.records.map(({ goal, status, sequence }) => ({ goal, status, sequence }))).toEqual([
      { goal: 'PEDIR', status: 'ACTIVE', sequence: 1 },
      { goal: 'EXPLORAR', status: 'PENDING', sequence: 2 },
      { goal: 'EXPLORAR', status: 'PENDING', sequence: 3 },
    ]);
    expect(state.records.filter(({ status }) => status === 'ACTIVE')).toHaveLength(1);
  });

  it('productos de un solo PEDIR permanecen en un único record', async () => {
    await applyDecision('turn-one-order', {
      decision: 'NEW_INTENT',
      intents: [{ goal: 'PEDIR', request: { products: ['ceviche', 'lomo'] } }],
    });

    expect((await getHumanIntentState(CONVERSATION_ID)).records).toHaveLength(1);
  });

  it('revision obsoleta rechaza la decisión sin mutar estado', async () => {
    await createHumanIntent(CONVERSATION_ID, input('PEDIR'));
    const before = await getHumanIntentState(CONVERSATION_ID);
    const result = await applyDecision(
      'turn-stale',
      { decision: 'NEW_INTENT', intents: [{ goal: 'EXPLORAR', request: { category: 'postres' } }] },
      before.revision - 1
    );

    expect(result.status).toBe('stale');
    expect(await getHumanIntentState(CONVERSATION_ID)).toEqual(before);
  });

  it('el mismo messageId aplicado dos veces no crea records adicionales', async () => {
    const decision = {
      decision: 'NEW_INTENT' as const,
      intents: [{ goal: 'PEDIR' as const, request: { products: ['ceviche'] } }],
    };
    const first = await applyDecision('turn-idempotent', decision);
    const afterFirst = await getHumanIntentState(CONVERSATION_ID);
    const second = await applyDecision('turn-idempotent', decision);

    expect(first.status).toBe('applied');
    expect(second.status).toBe('duplicate');
    expect(await getHumanIntentState(CONVERSATION_ID)).toEqual(afterFirst);
  });

  it('un batch inválido no deja una transición parcial', async () => {
    await createHumanIntent(CONVERSATION_ID, input('PEDIR'));
    const before = await getHumanIntentState(CONVERSATION_ID);

    await expect(
      applyDecision('turn-invalid-batch', {
        decision: 'NEW_INTENT',
        intents: [
          { goal: 'EXPLORAR', request: { category: 'postres' } },
          { goal: 'EXPLORAR', request: { category: 'postres' } },
        ],
      })
    ).rejects.toThrow(/duplicate goals/i);

    expect(await getHumanIntentState(CONVERSATION_ID)).toEqual(before);
  });

  it('metadata legacy sin revision migra en lectura a revision 0', async () => {
    stateStore.metadata = {
      checkout_active: true,
      humanIntentState: { version: 1, nextSequence: 1, records: [] },
    };

    expect(await getHumanIntentState(CONVERSATION_ID)).toMatchObject({ revision: 0 });
  });
});