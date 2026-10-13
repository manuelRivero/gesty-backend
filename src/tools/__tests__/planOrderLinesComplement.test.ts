/**
 * plan_order_lines cierra la ola de complemento al abrir cola multi-línea.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn() },
  },
}));

vi.mock('../../services/menu.service', () => ({ MenuService: {} }));

const store = { metadata: { peopleCount: 2 } as Record<string, unknown> };

const omitConversationMetadataKeys = vi.fn(async (_conversationId: string, keys: string[]) => {
  for (const key of keys) delete store.metadata[key];
});
const patchConversationMetadata = vi.fn(async (_conversationId: string, patch: Record<string, unknown>) => {
  store.metadata = { ...store.metadata, ...patch };
});

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: (...args: [string, Record<string, unknown>]) => patchConversationMetadata(...args),
  omitConversationMetadataKeys: (...args: [string, string[]]) => omitConversationMetadataKeys(...args),
}));

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: async () => ({ metadata: store.metadata }),
    patchConversationMetadata: (...args: [string, Record<string, unknown>]) => patchConversationMetadata(...args),
    omitConversationMetadataKeys: (...args: [string, string[]]) => omitConversationMetadataKeys(...args),
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

const clearComplementSuggestionSnapshot = vi.fn();
vi.mock('../../services/complementSuggestions.service', () => ({
  clearComplementSuggestionSnapshot: (...args: unknown[]) =>
    clearComplementSuggestionSnapshot(...args),
}));

import { getPendingOrderLines } from '../../services/pendingOrderLines.service';
import { planOrderLinesTool } from '../index';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

describe('plan_order_lines + ola de complemento', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.metadata = { peopleCount: 2 };
  });

  it('limpia shortlist/ola de complemento al crear la cola', async () => {
    const raw = await planOrderLinesTool.invoke(
      {
        lines: [
          { hint: 'adobo', requestedQuantity: 1 },
          { hint: 'ají de gallina', requestedQuantity: 1 },
        ],
      },
      CONFIG
    );
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;
    expect(result.success).toBe(true);
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith(
      'conv-1',
      expect.arrayContaining([
        'pendingProductSelection',
        'pendingComplementSelection',
        'candidateProductIds',
      ])
    );
    expect(clearComplementSuggestionSnapshot).toHaveBeenCalledWith('conv-1');
  });

  it('preserva UNKNOWN cuando requestedQuantity fue omitido', async () => {
    await planOrderLinesTool.invoke({
      lines: [{ hint: 'papas' }, { hint: 'ceviche' }],
    }, CONFIG);

    const pending = getPendingOrderLines(store.metadata);
    expect(pending?.lines.map((l) => ({ hint: l.hint, requestedQuantity: l.requestedQuantity, pendingNote: l.pendingNote }))).toEqual([
      { hint: 'papas', requestedQuantity: null, pendingNote: null },
      { hint: 'ceviche', requestedQuantity: null, pendingNote: null },
    ]);
    for (const line of pending?.lines ?? []) {
      expect(line.requestedQuantity).toBeNull();
    }
  });

  it('transfiere pendingNote por línea sin cruzarlas ("ceviche con poco picante y papas sin cebolla")', async () => {
    await planOrderLinesTool.invoke(
      {
        lines: [
          { hint: 'ceviche', pendingNote: 'poco picante' },
          { hint: 'papas', pendingNote: 'sin cebolla' },
        ],
      },
      CONFIG
    );

    const pending = getPendingOrderLines(store.metadata);
    expect(pending?.lines.map((l) => ({ hint: l.hint, requestedQuantity: l.requestedQuantity, pendingNote: l.pendingNote }))).toEqual([
      { hint: 'ceviche', requestedQuantity: null, pendingNote: 'poco picante' },
      { hint: 'papas', requestedQuantity: null, pendingNote: 'sin cebolla' },
    ]);
  });

  it('una línea sin nota queda con pendingNote null (no inventa notas)', async () => {
    await planOrderLinesTool.invoke(
      {
        lines: [
          { hint: 'ceviche', pendingNote: 'poco picante' },
          { hint: 'chicha morada' },
        ],
      },
      CONFIG
    );

    const pending = getPendingOrderLines(store.metadata);
    expect(pending?.lines.map((l) => ({ hint: l.hint, requestedQuantity: l.requestedQuantity, pendingNote: l.pendingNote }))).toEqual([
      { hint: 'ceviche', requestedQuantity: null, pendingNote: 'poco picante' },
      { hint: 'chicha morada', requestedQuantity: null, pendingNote: null },
    ]);
  });

  it('con una línea ya `done` en la cola existente, plan_order_lines no la reabre — solo agrega la línea genuinamente nueva', async () => {
    store.metadata = {
      peopleCount: 2,
      pendingOrderLines: {
        lines: [
          { id: 'line-ceviche', hint: 'ceviche', requestedQuantity: 2, status: 'done', currentResolutionId: 'pr1:biz-1:conv-1:res-a', pendingNote: 'poco picante' },
        ],
        sourceMessage: 'ceviche',
        createdAt: new Date().toISOString(),
        closedAt: null,
      },
    };

    await planOrderLinesTool.invoke(
      {
        lines: [
          { hint: 'ceviche', pendingNote: 'poco picante' },
          { hint: 'papas', pendingNote: 'sin cebolla' },
        ],
      },
      CONFIG
    );

    const pending = getPendingOrderLines(store.metadata);
    // La línea de ceviche no se tocó: mismo id, status y resolución.
    expect(pending?.lines.find((l) => l.id === 'line-ceviche')).toMatchObject({
      status: 'done',
      currentResolutionId: 'pr1:biz-1:conv-1:res-a',
      requestedQuantity: 2,
      pendingNote: 'poco picante',
    });
    // Papas entra como línea nueva, en cola.
    expect(pending?.lines.find((l) => l.hint === 'papas')).toMatchObject({
      status: 'queued',
      pendingNote: 'sin cebolla',
    });
    expect(pending?.lines).toHaveLength(2);
  });

  it('CASE08 — no-op total (ceviche done + papas queued, ambas re-enunciadas): la respuesta NO ofrece una línea activa falsa ni instruye buscar/resolver directo; dirige a continue_order_line()', async () => {
    store.metadata = {
      peopleCount: 3,
      pendingOrderLines: {
        lines: [
          { id: 'line-ceviche', hint: 'ceviche', requestedQuantity: 2, status: 'done', currentResolutionId: 'pr1:biz-1:conv-1:res-ceviche', pendingNote: 'poca cebolla' },
          { id: 'line-papas', hint: 'papas a la huancaína', requestedQuantity: null, status: 'queued', currentResolutionId: null, pendingNote: 'no muy picantes' },
        ],
        sourceMessage: 'Quiero un ceviche y unas papas',
        createdAt: new Date().toISOString(),
        closedAt: null,
      },
    };

    const raw = await planOrderLinesTool.invoke(
      {
        lines: [
          { hint: 'ceviche', pendingNote: 'poca cebolla' },
          { hint: 'papas a la huancaína', pendingNote: 'no muy picantes' },
        ],
      },
      CONFIG
    );
    const result = typeof raw === 'string' ? JSON.parse(raw) : raw;

    // Antes de este fix, `activeLine` reportaba papas (vía el fallback de
    // getActiveOrderLine a la primera `queued`) y la instrucción le decía al
    // modelo que buscara/resolviera papas directo — el mismo paso que
    // resolve_product rechaza con task_not_active porque papas sigue
    // `queued`, no `active` (evidencia: CASE08, turno 5 real).
    expect(result.success).toBe(true);
    expect(result.activeLine).toBeNull();
    expect(result.instruction).toMatch(/continue_order_line\(\)/);
    // Puede mencionar search_products/resolve_product para PROHIBIRlas antes
    // de activar la línea — lo que no debe hacer es instruir a llamarlas.
    expect(result.instruction).not.toMatch(/llam[aá] search_products/i);
    expect(result.instruction).not.toMatch(/llam[aá] resolve_product/i);
    expect(result.instruction).toMatch(/PROHIBIDO search_products/);

    // Y el ledger sigue intacto: nada se tocó.
    const pending = getPendingOrderLines(store.metadata);
    expect(pending?.lines.find((l) => l.id === 'line-ceviche')).toMatchObject({ status: 'done', currentResolutionId: 'pr1:biz-1:conv-1:res-ceviche' });
    expect(pending?.lines.find((l) => l.id === 'line-papas')).toMatchObject({ status: 'queued', currentResolutionId: null });
  });
});
