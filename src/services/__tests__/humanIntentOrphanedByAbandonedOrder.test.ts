/**
 * Caracterización: ¿qué pasa con el HumanIntent PEDIR cuando TODAS las
 * OrderLine de la cola terminan `cancelled` y nunca se persistió nada en el
 * carrito? Reproduce el camino real (reconcileHumanIntentAfterToolEffect →
 * reconcileActiveHumanIntent → mutateState), sin mockear la decisión final:
 * solo se mockea el borde de infraestructura (prisma), igual que
 * humanIntentState.service.test.ts.
 *
 * Contexto: ver auditoría "Continuidad de pedidos compuestos" — el efecto que
 * emite cancel_order_line es `{ kind: 'order_plan_line_cancelled' }`, SIN
 * `reference` (src/tools/index.ts, cancelOrderLineTool). Este test confirma
 * si esa ausencia de `reference` deja el PEDIR activo huérfano.
 */

import type { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

const { prismaMock, stateStore, draftOrderFindFirst } = vi.hoisted(() => {
  const store: { metadata: Record<string, unknown> | null } = { metadata: {} };
  const prisma = {
    conversation_state: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
    draft_order: {
      findFirst: vi.fn(),
    },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  };
  return { prismaMock: prisma, stateStore: store, draftOrderFindFirst: prisma.draft_order.findFirst };
});

vi.mock('../../lib/prisma', () => ({ prisma: prismaMock }));

import {
  HumanIntentStateError,
  applyHumanIntentTurnDecision,
  cancelHumanIntent,
  createHumanIntent,
  getActiveHumanIntent,
  getHumanIntentState,
} from '../humanIntentState.service';
import {
  closeAbandonedPedirIntent,
  deriveRequestedWorkProgress,
  reconcileHumanIntentAfterToolEffect,
} from '../humanIntentReconciliation.service';

const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const BUSINESS_ID = 'biz-1';
const CUSTOMER_PHONE = '+5491100000000';

// Efecto real emitido por cancel_order_line (src/tools/index.ts, cancelOrderLineTool):
// `effect: { kind: 'order_plan_line_cancelled' }` — nunca lleva `reference`.
const ORDER_LINE_CANCELLED_EFFECT = {
  kind: 'order_plan_line_cancelled',
  occurredAt: '2026-10-18T12:00:00.000Z',
  success: true as const,
};

describe('PEDIR tras abandono total de la cola (sin efecto persistido)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateStore.metadata = {};

    prismaMock.conversation_state.upsert.mockImplementation(async () => ({}));
    prismaMock.conversation_state.findUnique.mockImplementation(async () => ({
      metadata: stateStore.metadata,
    }));
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: unknown) => unknown) => {
        const tx = {
          conversation_state: prismaMock.conversation_state,
          $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join(' ').toLowerCase();
            if (sql.includes('pg_advisory_xact_lock')) return 0;
            return prismaMock.$executeRaw(strings, ...values);
          },
        };
        return callback(tx);
      }
    );
    prismaMock.$executeRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
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
      }
    );
    draftOrderFindFirst.mockResolvedValue({ draft_order_item: [] });
  });

  it('deja el PEDIR ACTIVE aunque las dos líneas de la cola estén cancelled', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, {
      goal: 'PEDIR',
      request: { products: ['ceviche', 'papas a la huancaína'] },
    });
    expect(active.status).toBe('ACTIVE');

    // Estado persistido tal como quedaría tras:
    //   1) search_products(keyword="cevichito") → 0 resultados → resolveMissedSearchOrderLine
    //      matchea la línea "ceviche" → cancelOrderLine la cierra (tools/index.ts:480-496).
    //   2) El cliente rechaza "papas a la huancaína" → cancel_order_line la cierra también.
    // Construido como literal, igual que en humanIntentState.service.test.ts — no se
    // invoca pendingOrderLines.service aquí porque lo que se audita es la capa de
    // reconciliación de HumanIntent, no el cierre de la cola en sí (ver Test 2).
    stateStore.metadata = {
      ...stateStore.metadata,
      pendingOrderLines: {
        lines: [
          { id: 'line-ceviche', hint: 'ceviche', requestedQuantity: null, status: 'cancelled', currentResolutionId: null, pendingNote: null },
          { id: 'line-papas', hint: 'papas a la huancaína', requestedQuantity: null, status: 'cancelled', currentResolutionId: null, pendingNote: null },
        ],
        sourceMessage: 'un cevichito y unas papas a la huancaína',
        createdAt: '2026-10-18T11:55:00.000Z',
        closedAt: '2026-10-18T12:00:00.000Z',
      },
    };

    // Caracterización directa: con todas las líneas cerradas pero sin reference
    // persistida, deriveRequestedWorkProgress ya reporta todo "done" a nivel tarea,
    // pero `complete` queda en false porque exige además `effectPersisted`.
    const progress = deriveRequestedWorkProgress(active, stateStore.metadata, false);
    expect(progress.tasks).toEqual([
      { id: 'line-ceviche', status: 'done' },
      { id: 'line-papas', status: 'done' },
    ]);
    expect(progress.complete).toBe(false);

    // Camino real: el post-effect hook del cancel_order_line real no lleva `reference`.
    const resolved = await reconcileHumanIntentAfterToolEffect({
      conversationId: CONVERSATION_ID,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      effect: ORDER_LINE_CANCELLED_EFFECT,
    });

    expect(resolved).toBeNull();
    expect(draftOrderFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ business_id: BUSINESS_ID, customer_phone: CUSTOMER_PHONE }),
      })
    );

    const stillActive = await getActiveHumanIntent(CONVERSATION_ID);
    expect(stillActive).toMatchObject({ id: active.id, status: 'ACTIVE' });
    // Ningún otro camino de la capa HumanIntent movió el registro: no es RESOLVED
    // ni CANCELLED. No hay transición terminal para "abandono total" en el código
    // ejercido por este test.
  });

  it('control: con la misma cola cerrada, SI hay un draft_order_item con la reference del efecto, el PEDIR sí resuelve', async () => {
    // Confirma que el mock de infraestructura es fiel (no es "siempre null" por
    // construcción): el único factor que cambia es effectPersisted.
    const active = await createHumanIntent(CONVERSATION_ID, {
      goal: 'PEDIR',
      request: { products: ['ceviche'] },
    });
    stateStore.metadata = {
      ...stateStore.metadata,
      pendingOrderLines: {
        lines: [
          { id: 'line-ceviche', hint: 'ceviche', requestedQuantity: 2, status: 'done', currentResolutionId: null, pendingNote: null },
        ],
        sourceMessage: 'un ceviche',
        createdAt: '2026-10-18T11:55:00.000Z',
        closedAt: '2026-10-18T12:00:00.000Z',
      },
    };
    draftOrderFindFirst.mockResolvedValue({
      draft_order_item: [{ product_id: 'product-ceviche' }],
    });

    const resolved = await reconcileHumanIntentAfterToolEffect({
      conversationId: CONVERSATION_ID,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      effect: {
        kind: 'add_cart_item',
        reference: 'product-ceviche',
        occurredAt: '2026-10-18T12:00:00.000Z',
        success: true,
      },
    });

    expect(resolved).toMatchObject({ id: active.id, status: 'RESOLVED' });
    expect(await getActiveHumanIntent(CONVERSATION_ID)).toBeNull();
  });
});

describe('closeAbandonedPedirIntent — fix: cierre terminal del abandono total', () => {
  // Cola de locks por clave, igual que humanIntentState.service.test.ts: un
  // `pg_advisory_xact_lock(key)` concurrente espera el `gate` del titular
  // anterior y solo lo libera cuando SU PROPIA transacción termina. Sin esto,
  // dos `$transaction` mockeados corren realmente en paralelo y el test de
  // concurrencia no ejercitaría la relectura-bajo-lock real.
  let advisoryTails: Map<string, Promise<void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    stateStore.metadata = {};
    advisoryTails = new Map();

    prismaMock.conversation_state.upsert.mockImplementation(async () => ({}));
    prismaMock.conversation_state.findUnique.mockImplementation(async () => ({
      metadata: stateStore.metadata,
    }));
    prismaMock.$transaction.mockImplementation(
      async (callback: (tx: unknown) => unknown) => {
        const releases: Array<() => void> = [];
        const tx = {
          conversation_state: prismaMock.conversation_state,
          $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const sql = strings.join(' ').toLowerCase();
            if (sql.includes('pg_advisory_xact_lock')) {
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
      }
    );
    prismaMock.$executeRaw.mockImplementation(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
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
      }
    );
    draftOrderFindFirst.mockResolvedValue({ draft_order_item: [] });
  });

  const closedAbandonedQueue = (lines: Array<{ id: string; hint: string; status: string }>) => ({
    pendingOrderLines: {
      lines: lines.map((l) => ({
        ...l,
        requestedQuantity: null,
        currentResolutionId: null,
        pendingNote: null,
      })),
      sourceMessage: 'un cevichito y unas papas a la huancaína',
      createdAt: '2026-10-18T11:55:00.000Z',
      closedAt: '2026-10-18T12:00:00.000Z',
    },
  });

  it('1) todas las líneas canceladas y nada en el carrito: el PEDIR termina CANCELLED, sin outcome de éxito', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, {
      goal: 'PEDIR',
      request: { products: ['ceviche', 'papas a la huancaína'] },
    });
    stateStore.metadata = {
      ...stateStore.metadata,
      ...closedAbandonedQueue([
        { id: 'line-ceviche', hint: 'ceviche', status: 'cancelled' },
        { id: 'line-papas', hint: 'papas a la huancaína', status: 'cancelled' },
      ]),
    };

    const closed = await closeAbandonedPedirIntent({
      conversationId: CONVERSATION_ID,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
    });

    expect(closed).toMatchObject({ id: active.id, status: 'CANCELLED' });
    expect(closed?.outcome).toBeUndefined();
    expect(await getActiveHumanIntent(CONVERSATION_ID)).toBeNull();
  });

  it('2) pedido parcialmente completado (un ítem sí persistió): no se clasifica como abandono', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, {
      goal: 'PEDIR',
      request: { products: ['ceviche', 'papas a la huancaína'] },
    });
    stateStore.metadata = {
      ...stateStore.metadata,
      ...closedAbandonedQueue([
        { id: 'line-ceviche', hint: 'ceviche', status: 'done' },
        { id: 'line-papas', hint: 'papas a la huancaína', status: 'cancelled' },
      ]),
    };
    draftOrderFindFirst.mockResolvedValue({
      draft_order_item: [{ product_id: 'product-ceviche' }],
    });

    const closed = await closeAbandonedPedirIntent({
      conversationId: CONVERSATION_ID,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
    });

    expect(closed).toBeNull();
    expect(await getActiveHumanIntent(CONVERSATION_ID)).toMatchObject({
      id: active.id,
      status: 'ACTIVE',
    });
  });

  it('3) cola cerrada y abandonada que no corresponde a la intención ACTIVE: no la cancela', async () => {
    // El PEDIR original queda suspendido (PENDING) con su cola ya cerrada y
    // abandonada; el goal ACTIVE pasa a ser otro (RESERVAR). La cola sigue
    // reflejando el pedido abandonado, pero "lo activo ahora" no es PEDIR.
    const pedir = await createHumanIntent(CONVERSATION_ID, {
      goal: 'PEDIR',
      request: { products: ['ceviche'] },
    });
    const reservar = await createHumanIntent(CONVERSATION_ID, {
      goal: 'RESERVAR',
      request: { partySize: 2 },
    });
    stateStore.metadata = {
      ...stateStore.metadata,
      ...closedAbandonedQueue([{ id: 'line-ceviche', hint: 'ceviche', status: 'cancelled' }]),
    };

    const closed = await closeAbandonedPedirIntent({
      conversationId: CONVERSATION_ID,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
    });

    expect(closed).toBeNull();
    expect(await getActiveHumanIntent(CONVERSATION_ID)).toMatchObject({
      id: reservar.id,
      status: 'ACTIVE',
    });
    const state = await getHumanIntentState(CONVERSATION_ID);
    expect(state.records.find((r) => r.id === pedir.id)?.status).toBe('PENDING');
  });

  it('4) reconciliación repetida sobre el mismo abandono es idempotente', async () => {
    await createHumanIntent(CONVERSATION_ID, {
      goal: 'PEDIR',
      request: { products: ['ceviche'] },
    });
    stateStore.metadata = {
      ...stateStore.metadata,
      ...closedAbandonedQueue([{ id: 'line-ceviche', hint: 'ceviche', status: 'cancelled' }]),
    };

    const first = await closeAbandonedPedirIntent({
      conversationId: CONVERSATION_ID,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
    });
    expect(first).toMatchObject({ status: 'CANCELLED' });

    const second = await closeAbandonedPedirIntent({
      conversationId: CONVERSATION_ID,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
    });
    expect(second).toBeNull();
  });

  it('5) una intención PEDIR nueva tras el abandono no hereda el estado ni queda bloqueada', async () => {
    const abandoned = await createHumanIntent(CONVERSATION_ID, {
      goal: 'PEDIR',
      request: { products: ['ceviche', 'papas a la huancaína'] },
    });
    stateStore.metadata = {
      ...stateStore.metadata,
      ...closedAbandonedQueue([
        { id: 'line-ceviche', hint: 'ceviche', status: 'cancelled' },
        { id: 'line-papas', hint: 'papas a la huancaína', status: 'cancelled' },
      ]),
    };
    await closeAbandonedPedirIntent({
      conversationId: CONVERSATION_ID,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
    });
    expect(await getActiveHumanIntent(CONVERSATION_ID)).toBeNull();

    const before = await getHumanIntentState(CONVERSATION_ID);
    const applied = await applyHumanIntentTurnDecision({
      conversationId: CONVERSATION_ID,
      messageId: 'msg-new-order',
      expectedRevision: before.revision,
      decision: {
        decision: 'NEW_INTENT',
        intents: [{ goal: 'PEDIR', request: { products: ['hamburguesa'] } }],
      },
    });

    expect(applied.status).toBe('applied');
    const fresh = await getActiveHumanIntent(CONVERSATION_ID);
    expect(fresh).toMatchObject({ status: 'ACTIVE', request: { products: ['hamburguesa'] } });
    expect(fresh?.id).not.toBe(abandoned.id);
    const state = await getHumanIntentState(CONVERSATION_ID);
    expect(state.records.find((r) => r.id === abandoned.id)?.status).toBe('CANCELLED');
  });

  it('6) el camino de éxito existente sigue resolviendo igual, y el cierre de abandono no interfiere después', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, {
      goal: 'PEDIR',
      request: { products: ['ceviche'] },
    });
    stateStore.metadata = {
      ...stateStore.metadata,
      ...closedAbandonedQueue([{ id: 'line-ceviche', hint: 'ceviche', status: 'done' }]),
    };
    draftOrderFindFirst.mockResolvedValue({
      draft_order_item: [{ product_id: 'product-ceviche' }],
    });

    const resolved = await reconcileHumanIntentAfterToolEffect({
      conversationId: CONVERSATION_ID,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
      effect: {
        kind: 'add_cart_item',
        reference: 'product-ceviche',
        occurredAt: '2026-10-18T12:00:00.000Z',
        success: true,
      },
    });
    expect(resolved).toMatchObject({ id: active.id, status: 'RESOLVED' });

    const afterward = await closeAbandonedPedirIntent({
      conversationId: CONVERSATION_ID,
      businessId: BUSINESS_ID,
      customerPhone: CUSTOMER_PHONE,
    });
    expect(afterward).toBeNull();
  });

  it('7) concurrencia real: dos cierres simultáneos leen el mismo ACTIVE antes de que ninguno escriba, y solo uno cancela', async () => {
    const active = await createHumanIntent(CONVERSATION_ID, {
      goal: 'PEDIR',
      request: { products: ['ceviche', 'papas a la huancaína'] },
    });
    stateStore.metadata = {
      ...stateStore.metadata,
      ...closedAbandonedQueue([
        { id: 'line-ceviche', hint: 'ceviche', status: 'cancelled' },
        { id: 'line-papas', hint: 'papas a la huancaína', status: 'cancelled' },
      ]),
    };

    const call = () =>
      closeAbandonedPedirIntent({
        conversationId: CONVERSATION_ID,
        businessId: BUSINESS_ID,
        customerPhone: CUSTOMER_PHONE,
      });

    // Ambas llamadas arrancan en el mismo tick: su primer await (el
    // Promise.all interno de closeAbandonedPedirIntent) deja que las DOS
    // lean conversation_state/draft_order/getActiveHumanIntent contra el
    // MISMO stateStore.metadata todavía no cancelado — ninguna lectura pasa
    // por el advisory lock (solo la escritura de cancelHumanIntent lo hace).
    // Recién al llegar a cancelHumanIntent una de las dos queda encolada
    // detrás de advisoryTails y relee el estado YA cancelado por la otra.
    // Ambas promesas deben resolver (ninguna puede rechazar: esa es
    // justamente la condición que este fix agrega).
    const results = await Promise.all([call(), call()]);
    const [first, second] = results;

    const cancelledResults = [first, second].filter(
      (r): r is NonNullable<typeof r> => r !== null
    );
    const nullResults = [first, second].filter((r) => r === null);
    expect(cancelledResults).toHaveLength(1);
    expect(nullResults).toHaveLength(1);
    expect(cancelledResults[0]).toMatchObject({ id: active.id, status: 'CANCELLED' });
    expect(cancelledResults[0].outcome).toBeUndefined();

    expect(await getActiveHumanIntent(CONVERSATION_ID)).toBeNull();
    const state = await getHumanIntentState(CONVERSATION_ID);
    const records = state.records.filter((r) => r.id === active.id);
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe('CANCELLED');
  });

  it('8) un HumanIntentStateError distinto de "already terminal" no queda silenciado por el catch de la carrera', async () => {
    // No se simula una carrera artificial contra un id inexistente: se prueba
    // directamente, con el servicio real, que un HumanIntentStateError por una
    // causa distinta (id desconocido, vía requireOpenIntent → indexById)
    // produce un mensaje que closeAbandonedPedirIntent NO puede confundir con
    // "ya es terminal" — por lo tanto seguiría propagándose si ocurriera ahí.
    await createHumanIntent(CONVERSATION_ID, { goal: 'PEDIR', request: { products: ['ceviche'] } });

    const unknownId = 'intent-que-no-existe';
    await expect(cancelHumanIntent(CONVERSATION_ID, unknownId)).rejects.toThrow(
      HumanIntentStateError
    );
    await expect(cancelHumanIntent(CONVERSATION_ID, unknownId)).rejects.toThrow(
      `Unknown human intent: ${unknownId}`
    );
    // Si closeAbandonedPedirIntent hubiera llegado a este error, su condición
    // `error.message === \`Human intent ${active.id} is already terminal\``
    // es falsa para "Unknown human intent: ...", así que el catch lo
    // re-lanza (`throw error`) en vez de devolver null.
  });
});
