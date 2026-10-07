/**
 * continue_order_line: success:true ⇔ una línea pasó efectivamente QUEUED → ACTIVE.
 *
 * Evidencia (E2E human-intent-lifecycle, TURN 5): el modelo emitió
 * add_cart_item(ceviche) + continue_order_line() en el mismo lote; el continue
 * evaluó ceviche todavía ACTIVE, no activó nada y aun así devolvía success:true.
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

import { advanceAfterLineClose, getPendingOrderLines } from '../../services/pendingOrderLines.service';
import { continueOrderLineTool } from '../index';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const callTool = async () =>
  JSON.parse((await continueOrderLineTool.func({}, undefined, CONFIG)) as string) as Record<string, unknown>;

const seedQueue = () => {
  store.metadata = {
    pendingOrderLines: {
      lines: [
        { id: 'line-a', hint: 'ceviche', requestedQuantity: 2, status: 'active', currentResolutionId: 'pr1:biz-1:conv-1:res-a' },
        { id: 'line-b', hint: 'papas', requestedQuantity: null, status: 'queued', currentResolutionId: null },
      ],
      sourceMessage: 'Quiero un ceviche y unas papas',
      createdAt: new Date().toISOString(),
    },
  };
};

const lineStatus = (id: string) =>
  getPendingOrderLines(store.metadata)?.lines.find((line) => line.id === id);

describe('continue_order_line', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedQueue();
  });

  it('Caso A — con A cerrada, promueve B de QUEUED a ACTIVE y devuelve success:true', async () => {
    // Mismo cierre que ejecuta add_cart_item sobre la Task exacta.
    await advanceAfterLineClose({ conversationId: 'conv-1', lineId: 'line-a', closeStatus: 'done' });

    const result = await callTool();

    expect(result).toMatchObject({
      success: true,
      effect: { kind: 'order_plan_advanced' },
      activeLine: { hint: 'papas', requestedQuantity: null },
    });
    expect(lineStatus('line-a')?.status).toBe('done');
    expect(lineStatus('line-b')).toMatchObject({ status: 'active', currentResolutionId: null, requestedQuantity: null });
  });

  it('Caso B — con A todavía ACTIVE no hay transición: success:false order_line_still_active y sin mutaciones', async () => {
    const before = structuredClone(store.metadata);

    const result = await callTool();

    expect(result).toMatchObject({ success: false, error: 'order_line_still_active' });
    expect(result.effect).toBeUndefined();
    expect(lineStatus('line-a')?.status).toBe('active');
    expect(lineStatus('line-b')).toEqual({
      id: 'line-b',
      hint: 'papas',
      requestedQuantity: null,
      status: 'queued',
      currentResolutionId: null,
    });
    expect(store.metadata).toEqual(before);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('sin cola conserva no_pending_order_lines', async () => {
    store.metadata = {};

    const result = await callTool();

    expect(result).toEqual({ success: false, error: 'no_pending_order_lines' });
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });
});
