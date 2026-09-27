/**
 * search_products count 0 cierra la línea de cola que el keyword cubre.
 * Un "no lo tenemos" deja de reinyectar ese plato en el turno siguiente.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchMenuItemsByKeyword = vi.fn();
const findOrCreateConversationState = vi.fn();
const patchConversationMetadata = vi.fn();
const omitConversationMetadataKeys = vi.fn();

vi.mock('../../lib/prisma', () => ({
  prisma: {
    business: { findUnique: vi.fn() },
    menu_item: { count: vi.fn(), findMany: vi.fn() },
  },
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: {
    searchMenuItemsByKeyword: (...args: unknown[]) => searchMenuItemsByKeyword(...args),
  },
}));

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: (...args: unknown[]) => patchConversationMetadata(...args),
  omitConversationMetadataKeys: (...args: unknown[]) =>
    omitConversationMetadataKeys(...args),
}));

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: (...args: unknown[]) =>
      findOrCreateConversationState(...args),
    patchConversationMetadata: (...args: unknown[]) => patchConversationMetadata(...args),
    omitConversationMetadataKeys: (...args: unknown[]) =>
      omitConversationMetadataKeys(...args),
  };
});

import { searchProductsTool } from '../index';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const queue = (lines: Array<Record<string, unknown>>) => ({
  peopleCount: 3,
  pendingOrderLines: {
    lines,
    sourceMessage: 'un cevichito y un lomo',
    createdAt: '2026-09-27T04:00:00.000Z',
  },
});

const callSearch = (keyword: string) =>
  searchProductsTool.func({ keyword } as never, undefined, CONFIG);

describe('search_products count 0 y cola de pedido', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchMenuItemsByKeyword.mockResolvedValue([]);
    patchConversationMetadata.mockResolvedValue(undefined);
    omitConversationMetadataKeys.mockResolvedValue(undefined);
  });

  it('cancela la línea cuyo hint cubre el keyword y deja el resto en cola', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: queue([
        { id: 'l1', hint: 'lomo', requestedQuantity: 1, status: 'active' },
        { id: 'l2', hint: 'ceviche', requestedQuantity: 1, status: 'queued' },
      ]),
    });

    const result = JSON.parse((await callSearch('lomo')) as string);

    expect(result.count).toBe(0);
    expect(result.lineClosed).toEqual({ hint: 'lomo' });
    expect(result.queueFollowUp.nextHint).toBe('ceviche');
    expect(result.instruction).toMatch(/una sola vez/i);
    expect(result.instruction).toMatch(/lineClosed/);
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        pendingOrderLines: expect.objectContaining({
          lines: expect.arrayContaining([
            expect.objectContaining({ id: 'l1', status: 'cancelled' }),
            expect.objectContaining({ id: 'l2', status: 'queued' }),
          ]),
        }),
      })
    );
  });

  it('no cancela otra línea ni un recorte del hint', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: queue([
        {
          id: 'l1',
          hint: 'papas a la huancaína',
          requestedQuantity: 1,
          status: 'active',
        },
      ]),
    });

    const other = JSON.parse((await callSearch('lomo')) as string);
    expect(other.lineClosed).toBeUndefined();
    expect(patchConversationMetadata).not.toHaveBeenCalled();

    const carved = JSON.parse((await callSearch('papa')) as string);
    expect(carved.lineClosed).toBeUndefined();
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('sin cola solo avisa: no escribe metadata', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: { peopleCount: 3 },
    });

    const result = JSON.parse((await callSearch('lomo')) as string);

    expect(result.count).toBe(0);
    expect(result.lineClosed).toBeUndefined();
    expect(result.instruction).toMatch(/no lo tenemos/i);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('turno de reserva no cancela líneas de pedido', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: {
        reservation_agent_active: true,
        ...queue([{ id: 'l1', hint: 'lomo', requestedQuantity: 1, status: 'active' }]),
      },
    });

    const result = JSON.parse((await callSearch('lomo')) as string);

    expect(result.lineClosed).toBeUndefined();
    expect(result.instruction).toMatch(/Turno de reserva/);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });
});

describe('search_products — dos nombres para el mismo keyword', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchConversationMetadata.mockResolvedValue(undefined);
    omitConversationMetadataKeys.mockResolvedValue(undefined);
    findOrCreateConversationState.mockResolvedValue({
      metadata: { peopleCount: 3 },
    });
  });

  it('pide la lista solo con los platos que se llaman como la búsqueda y no suma vecinos', async () => {
    searchMenuItemsByKeyword.mockResolvedValue([
      { id: 'cev-1', name: 'Ceviche Clásico', serves_people: 2 },
      { id: 'cev-2', name: 'Ceviche clasico con variaciones', serves_people: 1 },
      { id: 'tir-1', name: 'Tiradito de pescado', serves_people: 1 },
    ]);

    const result = JSON.parse((await callSearch('ceviche')) as string);

    expect(result.ambiguousProductIds).toEqual(['cev-1', 'cev-2']);
    expect(result.instruction).toMatch(/present_product_cta\(SELECT_FROM_LIST\)/);
    expect(result.instruction).toMatch(/PROHIBIDO add_cart_item/);
    expect(result.items.map((item: { id: string }) => item.id)).toEqual([
      'cev-1',
      'cev-2',
      'tir-1',
    ]);
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        candidateProductIds: ['cev-1', 'cev-2'],
        pendingQuestion: 'ceviche',
      })
    );
  });

  it('un solo nombre coincidente no arma la lista de ambigüedad', async () => {
    searchMenuItemsByKeyword.mockResolvedValue([
      { id: 'cev-1', name: 'Ceviche Clásico', serves_people: 2 },
      { id: 'tir-1', name: 'Tiradito de pescado', serves_people: 1 },
    ]);

    const result = JSON.parse((await callSearch('ceviche')) as string);

    expect(result.ambiguousProductIds).toBeUndefined();
    expect(result.instruction).toMatch(/platos exactos/);
  });
});
