/**
 * cancel_order_line no debe cancelar la última línea abierta (cierra toda la
 * cola) cuando el intento de tool inmediatamente anterior de este mismo turno
 * falló a nivel de esquema/ToolNode — ese patrón (plan_order_lines rechazado
 * por `.min(2)` → cancel_order_line como "recuperación") fue la causa de que
 * CASE08 perdiera la línea de papas tras agregar el ceviche.
 *
 * `lastToolOutcome` lo escribe `PostEffectToolNode.runTool` para cada
 * intento de tool del turno (éxito o no) — es la única señal garantizada
 * por el sistema, no autoreportada por el modelo.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = { metadata: {} as Record<string, unknown> };
const patchConversationMetadata = vi.fn(async (_conversationId: string, patch: Record<string, unknown>) => {
  store.metadata = { ...store.metadata, ...patch };
});
const findOrCreateConversationState = vi.fn(async () => ({ metadata: store.metadata }));

vi.mock('../../lib/prisma', () => ({ prisma: {} }));
vi.mock('../../services/menu.service', () => ({ MenuService: {} }));

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: (...args: [string, Record<string, unknown>]) => patchConversationMetadata(...args),
  omitConversationMetadataKeys: vi.fn(),
}));

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: () => findOrCreateConversationState(),
    patchConversationMetadata: (...args: [string, Record<string, unknown>]) => patchConversationMetadata(...args),
    omitConversationMetadataKeys: vi.fn(),
    mutateConversationMetadata: async (
      _conversationId: string,
      mutate: (current: Record<string, unknown>) => { metadata: Record<string, unknown> | null; result: unknown }
    ) => {
      const mutation = mutate(store.metadata);
      if (mutation.metadata) store.metadata = mutation.metadata;
      return mutation.result;
    },
  };
});

import { getPendingOrderLines, recordLastToolOutcome } from '../../services/pendingOrderLines.service';
import { cancelOrderLineTool, continueOrderLineTool } from '../index';

const TURN_ID = 'turn-5';
const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
    turnId: TURN_ID,
  },
};

const callCancel = async (hint?: string) =>
  JSON.parse((await cancelOrderLineTool.func({ hint }, undefined, CONFIG)) as string) as Record<string, unknown>;

const callContinue = async () =>
  JSON.parse((await continueOrderLineTool.func({}, undefined, CONFIG)) as string) as Record<string, unknown>;

/** Ceviche ya `done` (en el carrito), papas la única línea abierta. */
const seedSingleOpenLine = () => {
  store.metadata = {
    pendingOrderLines: {
      lines: [
        { id: 'line-ceviche', hint: 'ceviche', requestedQuantity: 2, status: 'done', currentResolutionId: 'pr1:biz-1:conv-1:res-a', pendingNote: 'poca cebolla' },
        { id: 'line-papas', hint: 'papas a la huancaína', requestedQuantity: null, status: 'queued', currentResolutionId: null, pendingNote: 'no muy picantes' },
      ],
      sourceMessage: 'Quiero un ceviche y unas papas',
      createdAt: new Date().toISOString(),
      closedAt: null,
    },
  };
};

/** Dos líneas abiertas: cancelar una no cierra la cola entera. */
const seedTwoOpenLines = () => {
  store.metadata = {
    pendingOrderLines: {
      lines: [
        { id: 'line-ceviche', hint: 'ceviche', requestedQuantity: 2, status: 'active', currentResolutionId: 'pr1:biz-1:conv-1:res-a', pendingNote: 'poca cebolla' },
        { id: 'line-papas', hint: 'papas a la huancaína', requestedQuantity: null, status: 'queued', currentResolutionId: null, pendingNote: 'no muy picantes' },
      ],
      sourceMessage: 'Quiero un ceviche y unas papas',
      createdAt: new Date().toISOString(),
      closedAt: null,
    },
  };
};

describe('cancel_order_line — guardia de recuperación tras error de esquema', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.metadata = {};
  });

  it('bloquea la cancelación de la única línea abierta si la tool anterior de este turno falló (esquema)', async () => {
    seedSingleOpenLine();
    await recordLastToolOutcome('conv-1', { turnId: TURN_ID, toolName: 'plan_order_lines', success: false });

    const result = await callCancel('papas a la huancaína');

    expect(result).toMatchObject({ success: false, error: 'cancel_blocked_after_tool_error' });
    // No se tocó la línea: sigue queued, con su nota intacta.
    const papas = getPendingOrderLines(store.metadata)?.lines.find((l) => l.id === 'line-papas');
    expect(papas).toMatchObject({ status: 'queued', pendingNote: 'no muy picantes' });
  });

  it('un rechazo de esquema no dispara por sí mismo ninguna cancelación — solo el intento explícito de cancel queda bloqueado', async () => {
    seedSingleOpenLine();
    await recordLastToolOutcome('conv-1', { turnId: TURN_ID, toolName: 'plan_order_lines', success: false });

    // Nadie llamó cancel_order_line todavía: el estado no cambia solo por
    // haber registrado el fallo de esquema.
    expect(getPendingOrderLines(store.metadata)?.lines.find((l) => l.id === 'line-papas')?.status).toBe('queued');
  });

  it('continue_order_line (el camino normal) sigue funcionando igual tras un fallo de esquema previo', async () => {
    seedSingleOpenLine();
    await recordLastToolOutcome('conv-1', { turnId: TURN_ID, toolName: 'plan_order_lines', success: false });

    const result = await callContinue();

    expect(result).toMatchObject({ success: true, effect: { kind: 'order_plan_advanced' } });
    expect(getPendingOrderLines(store.metadata)?.lines.find((l) => l.id === 'line-papas')?.status).toBe('active');
  });

  it('permite cancelar la última línea abierta sin un fallo de esquema inmediatamente antes (cancelación explícita y autorizada)', async () => {
    seedSingleOpenLine();
    await recordLastToolOutcome('conv-1', { turnId: TURN_ID, toolName: 'get_cart', success: true });

    const result = await callCancel('papas a la huancaína');

    expect(result).toMatchObject({ cancelled: true, queueEmpty: true });
    expect(getPendingOrderLines(store.metadata)?.lines.find((l) => l.id === 'line-papas')?.status).toBe('cancelled');
  });

  it('permite cancelar la última línea abierta sin ningún lastToolOutcome registrado (primer tool call del turno)', async () => {
    seedSingleOpenLine();

    const result = await callCancel('papas a la huancaína');

    expect(result).toMatchObject({ cancelled: true, queueEmpty: true });
  });

  it('un fallo de esquema de un turno anterior no bloquea un cancel legítimo en un turno nuevo', async () => {
    seedSingleOpenLine();
    await recordLastToolOutcome('conv-1', { turnId: 'turn-anterior', toolName: 'plan_order_lines', success: false });

    const result = await callCancel('papas a la huancaína');

    expect(result).toMatchObject({ cancelled: true, queueEmpty: true });
  });

  it('con dos líneas abiertas, cancelar una de ellas NO cierra la cola — la guardia no aplica aunque haya fallado la tool anterior', async () => {
    seedTwoOpenLines();
    await recordLastToolOutcome('conv-1', { turnId: TURN_ID, toolName: 'plan_order_lines', success: false });

    const result = await callCancel('ceviche');

    expect(result).toMatchObject({ cancelled: true });
    expect(result.queueEmpty).toBeUndefined();
    expect(getPendingOrderLines(store.metadata)?.lines.find((l) => l.id === 'line-ceviche')?.status).toBe('cancelled');
    expect(getPendingOrderLines(store.metadata)?.lines.find((l) => l.id === 'line-papas')?.status).toBe('queued');
  });

  it('las líneas completadas, sus notas y cantidades no cambian como efecto colateral del bloqueo', async () => {
    seedSingleOpenLine();
    await recordLastToolOutcome('conv-1', { turnId: TURN_ID, toolName: 'plan_order_lines', success: false });

    await callCancel('papas a la huancaína');

    const ceviche = getPendingOrderLines(store.metadata)?.lines.find((l) => l.id === 'line-ceviche');
    expect(ceviche).toMatchObject({ status: 'done', requestedQuantity: 2, pendingNote: 'poca cebolla' });
  });
});
