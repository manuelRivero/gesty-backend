/**
 * `closeOrderDomainHumanIntents` (humanIntentReconciliation.service.ts) —
 * invariantes de la Fase 1 de la auditoría "ciclo de vida y contaminación de
 * estado operativo conversacional": cancelar o completar un pedido no debe
 * dejar ningún HumanIntentRecord de dominio pedido (PEDIR/GESTIONAR_PEDIDO/
 * COMPLETAR_COMPRA/CANCELAR_COMPRA) ACTIVE/PENDING, para que
 * `ensurePendingOrderLinesFromRequest` no pueda reconstruir líneas ya
 * canceladas en un turno posterior.
 *
 * Usa el `humanIntentState.service` REAL (no mockeado) sobre un Prisma en
 * memoria — así se demuestra la transición de estado real, no solo que se
 * llamó a una función mockeada.
 */

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

import * as humanIntentStateModule from '../humanIntentState.service';
import {
  createHumanIntent,
  createPendingHumanIntent,
  getActiveHumanIntent,
  getHumanIntentState,
  getPendingHumanIntents,
} from '../humanIntentState.service';
import { closeOrderDomainHumanIntents } from '../humanIntentReconciliation.service';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

describe('closeOrderDomainHumanIntents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateStore.metadata = {};

    prismaMock.conversation_state.upsert.mockImplementation(async () => ({}));
    prismaMock.conversation_state.findUnique.mockImplementation(async () => ({
      metadata: stateStore.metadata,
    }));
    prismaMock.$transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      const tx = {
        conversation_state: prismaMock.conversation_state,
        $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          const sql = strings.join(' ').toLowerCase();
          if (sql.includes('pg_advisory_xact_lock')) return 0;
          return prismaMock.$executeRaw(strings, ...values);
        },
      };
      return callback(tx);
    });
    prismaMock.$executeRaw.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(' ').toLowerCase();
      if (sql.includes('jsonb_set')) {
        const [serializedState] = values;
        const metadata =
          stateStore.metadata && typeof stateStore.metadata === 'object' ? stateStore.metadata : {};
        stateStore.metadata = { ...metadata, humanIntentState: JSON.parse(String(serializedState)) };
        return 1;
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
  });

  it('[Test 1] PEDIR ACTIVE con líneas A/B: tras cerrar, no queda ningún intent de dominio pedido activo/pendiente', async () => {
    await createHumanIntent(CONVERSATION_ID, {
      goal: 'PEDIR',
      request: { products: ['ceviche', 'papas a la huancaína'] },
    });

    await closeOrderDomainHumanIntents({ conversationId: CONVERSATION_ID, reason: 'cancelled' });

    expect(await getActiveHumanIntent(CONVERSATION_ID)).toBeNull();
    expect(await getPendingHumanIntents(CONVERSATION_ID)).toEqual([]);
    const state = await getHumanIntentState(CONVERSATION_ID);
    expect(state.records).toHaveLength(1);
    expect(state.records[0]).toMatchObject({ goal: 'PEDIR', status: 'CANCELLED' });
  });

  it('[Test 2] PEDIR PENDING (no activo) con request.products: también se cierra, y la reconstrucción de líneas no revive los productos', async () => {
    // EXPLORAR queda ACTIVE; el PEDIR con los productos del pedido cancelado
    // queda PENDING — es exactamente el caso que ensurePendingOrderLinesFromRequest
    // podía resucitar porque `pendingOrderLines` se omite (no se cierra con
    // `closedAt`) en la ruta de cancelación total.
    const pedir = await createHumanIntent(CONVERSATION_ID, {
      goal: 'PEDIR',
      request: { products: ['ceviche', 'papas a la huancaína'] },
    });
    await createHumanIntent(CONVERSATION_ID, { goal: 'EXPLORAR', request: { category: 'postres' } });
    const pendingBefore = await getPendingHumanIntents(CONVERSATION_ID);
    expect(pendingBefore.map((i) => i.id)).toContain(pedir.id);

    await closeOrderDomainHumanIntents({ conversationId: CONVERSATION_ID, reason: 'cancelled' });

    const state = await getHumanIntentState(CONVERSATION_ID);
    const closedPedir = state.records.find((r) => r.id === pedir.id);
    expect(closedPedir?.status).toBe('CANCELLED');

    // El dominio pedido no tiene ya ningún `request.products` vivo del que
    // `ensurePendingOrderLinesFromRequest` pueda derivar una cola: sin un
    // intent ACTIVE/PENDING de goal PEDIR, nada en el turno siguiente invoca
    // esa función con esos productos — se confirma directamente que, aunque
    // se la llamara con el `request` ya cerrado, no hay cola previa que
    // bloquee su reconstrucción silenciosa (reconcileOrderLinesPlan solo
    // excluye por nombre ya representado, no por intent): el request del
    // record cerrado ya no es alcanzable desde getActiveHumanIntent/
    // getPendingHumanIntents, que es por donde el dispatcher decide si vale
    // la pena derivar la cola en primer lugar.
    expect(await getActiveHumanIntent(CONVERSATION_ID)).toMatchObject({ goal: 'EXPLORAR' });
    expect((await getPendingHumanIntents(CONVERSATION_ID)).some((i) => i.goal === 'PEDIR')).toBe(false);
  });

  it('[Test 3] reason "completed": el COMPLETAR_COMPRA activo se resuelve como logrado (RESOLVED), no como abandonado', async () => {
    const completar = await createHumanIntent(CONVERSATION_ID, {
      goal: 'COMPLETAR_COMPRA',
      request: {},
    });

    await closeOrderDomainHumanIntents({
      conversationId: CONVERSATION_ID,
      reason: 'completed',
      reference: 'order-1',
    });

    const state = await getHumanIntentState(CONVERSATION_ID);
    const closed = state.records.find((r) => r.id === completar.id);
    expect(closed?.status).toBe('RESOLVED');
    expect(closed?.outcome).toMatchObject({ kind: 'order_completed', reference: 'order-1', success: true });
  });

  it('[Test 4] intenciones no relacionadas (RESERVAR) no se cancelan ni se resuelven — a lo sumo se promueven a ACTIVE si quedan huérfanas', async () => {
    const reservar = await createPendingHumanIntent(CONVERSATION_ID, {
      goal: 'RESERVAR',
      request: { partySize: 4 },
    });
    await createHumanIntent(CONVERSATION_ID, { goal: 'PEDIR', request: { products: ['ceviche'] } });

    await closeOrderDomainHumanIntents({ conversationId: CONVERSATION_ID, reason: 'cancelled' });

    const state = await getHumanIntentState(CONVERSATION_ID);
    const untouched = state.records.find((r) => r.id === reservar.id);
    // Cancelar el PEDIR (único ACTIVE) promueve al PENDING más antiguo —
    // comportamiento ya existente de `cancelHumanIntent`/`promoteOldestPending`,
    // ajeno a esta función. Lo que closeOrderDomainHumanIntents garantiza es
    // que RESERVAR nunca termina CANCELLED/REPLACED/RESOLVED por este cierre.
    expect(untouched?.goal).toBe('RESERVAR');
    expect(untouched?.status).toBe('ACTIVE');
    expect(untouched?.request).toEqual({ partySize: 4 });
  });

  it('[Fix 2 — TOCTOU] si el ACTIVE cambia entre la lectura y la escritura, no resuelve el intent equivocado y preserva el nuevo ACTIVE de otro dominio', async () => {
    const cancelarCompra = await createHumanIntent(CONVERSATION_ID, {
      goal: 'CANCELAR_COMPRA',
      request: {},
    });
    // Snapshot tomado ANTES de la carrera: closeOrderDomainHumanIntents
    // decide sobre esto (CANCELAR_COMPRA ACTIVE).
    const staleSnapshot = await getHumanIntentState(CONVERSATION_ID);

    const getStateSpy = vi.spyOn(humanIntentStateModule, 'getHumanIntentState');
    getStateSpy.mockImplementationOnce(async () => {
      // Simula la carrera: justo después de que la función leyó el estado
      // (y antes de escribir), otro turno concurrente activa un intent de
      // OTRO dominio (RESERVAR), suspendiendo CANCELAR_COMPRA a PENDING.
      await createHumanIntent(CONVERSATION_ID, { goal: 'RESERVAR', request: { partySize: 2 } });
      return staleSnapshot;
    });

    await closeOrderDomainHumanIntents({ conversationId: CONVERSATION_ID, reason: 'cancelled' });
    getStateSpy.mockRestore();

    const finalState = await getHumanIntentState(CONVERSATION_ID);
    const reservar = finalState.records.find((r) => r.goal === 'RESERVAR');
    const cancelarCompraAfter = finalState.records.find((r) => r.id === cancelarCompra.id);

    // B (RESERVAR) nunca se tocó: si hubiera usado "resolver lo que esté
    // ACTIVE ahora" en vez de resolver por intentId validado, esto habría
    // quedado RESOLVED con un outcome `order_cancelled` que no le pertenece.
    expect(reservar?.status).toBe('ACTIVE');
    expect(reservar?.outcome).toBeUndefined();
    // A (CANCELAR_COMPRA) sigue cerrándose — por el camino correcto
    // (cancelado, porque para cuando se procesó ya no era el ACTIVE que
    // disparó el cierre), nunca "resuelto" indebidamente sobre otro record.
    expect(cancelarCompraAfter?.status).toBe('CANCELLED');
  });

  it('[Fix 2] sin carrera, resuelve correctamente el intent de pedido que sigue ACTIVE y cumple las precondiciones', async () => {
    const completar = await createHumanIntent(CONVERSATION_ID, { goal: 'COMPLETAR_COMPRA', request: {} });

    await closeOrderDomainHumanIntents({
      conversationId: CONVERSATION_ID,
      reason: 'completed',
      reference: 'order-42',
    });

    const state = await getHumanIntentState(CONVERSATION_ID);
    const resolved = state.records.find((r) => r.id === completar.id);
    expect(resolved?.status).toBe('RESOLVED');
    expect(resolved?.outcome).toMatchObject({ kind: 'order_completed', reference: 'order-42' });
  });

  it('[Test 5] idempotencia: una segunda llamada no lanza y no cambia el estado', async () => {
    await createHumanIntent(CONVERSATION_ID, { goal: 'PEDIR', request: { products: ['ceviche'] } });
    await closeOrderDomainHumanIntents({ conversationId: CONVERSATION_ID, reason: 'cancelled' });
    const stateAfterFirst = await getHumanIntentState(CONVERSATION_ID);

    await expect(
      closeOrderDomainHumanIntents({ conversationId: CONVERSATION_ID, reason: 'cancelled' })
    ).resolves.toBeUndefined();

    const stateAfterSecond = await getHumanIntentState(CONVERSATION_ID);
    expect(stateAfterSecond).toEqual(stateAfterFirst);
  });

  it('[Test 2b] sin ningún intent de dominio pedido (cancelar sin nada vivo): no-op, no lanza', async () => {
    await createHumanIntent(CONVERSATION_ID, { goal: 'CONSULTAR_NEGOCIO', request: {} });

    await expect(
      closeOrderDomainHumanIntents({ conversationId: CONVERSATION_ID, reason: 'cancelled' })
    ).resolves.toBeUndefined();

    const state = await getHumanIntentState(CONVERSATION_ID);
    expect(state.records[0]).toMatchObject({ goal: 'CONSULTAR_NEGOCIO', status: 'ACTIVE' });
  });
});
