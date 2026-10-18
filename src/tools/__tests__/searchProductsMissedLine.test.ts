/**
 * search_products count 0 NO cancela la línea de cola que el keyword cubre
 * (Fase 2 — continuidad de pedidos compuestos): cero resultados para un
 * término puntual no demuestra que el plato no exista. La línea sigue
 * abierta; `missedOrderLine` solo identifica cuál era, para que la
 * instrucción al modelo la nombre bien y ofrezca reformular / seguir con el
 * resto / cancelar explícitamente si el cliente lo pide.
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

vi.mock('../../services/productResolution.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/productResolution.service')>();
  return {
    ...actual,
    issueProductResolutions: vi.fn(async ({ productIds }: { productIds: string[] }) =>
      productIds.map((productId) => ({ resolutionId: `test:${productId}`, productId }))
    ),
  };
});

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
    mutateConversationMetadata: async (
      conversationId: string,
      mutate: (metadata: Record<string, unknown>) => {
        metadata: Record<string, unknown> | null;
        result: unknown;
      }
    ) => {
      const state = await findOrCreateConversationState();
      const mutation = mutate(state.metadata as Record<string, unknown>);
      if (mutation.metadata) {
        await patchConversationMetadata(conversationId, {
          pendingOrderLines: mutation.metadata.pendingOrderLines,
        });
        findOrCreateConversationState.mockResolvedValue({ metadata: mutation.metadata });
      }
      return mutation.result;
    },
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

  it('NO cancela la línea cuyo hint cubre el keyword: la deja abierta y señala missedOrderLine', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: queue([
        { id: 'l1', hint: 'lomo', requestedQuantity: 1, status: 'active' },
        { id: 'l2', hint: 'ceviche', requestedQuantity: 1, status: 'queued' },
      ]),
    });

    const result = JSON.parse((await callSearch('lomo')) as string);

    expect(result.count).toBe(0);
    expect(result.missedOrderLine).toEqual({ hint: 'lomo' });
    expect(result.lineClosed).toBeUndefined();
    expect(result.queueFollowUp).toBeUndefined();
    expect(result.instruction).toMatch(/una sola vez/i);
    expect(result.instruction).toMatch(/sigue abierta, no se canceló/i);
    expect(result.instruction).toMatch(/PROHIBIDO decir "no lo tenemos"/);
    // Cero resultados no escribe nada en pendingOrderLines: la línea hermana
    // ("ceviche", queued) tampoco se toca.
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('no identifica otra línea ni un recorte del hint', async () => {
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
    expect(other.missedOrderLine).toBeUndefined();
    expect(patchConversationMetadata).not.toHaveBeenCalled();

    const carved = JSON.parse((await callSearch('papa')) as string);
    expect(carved.missedOrderLine).toBeUndefined();
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('sin cola solo avisa: no escribe metadata', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: { peopleCount: 3 },
    });

    const result = JSON.parse((await callSearch('lomo')) as string);

    expect(result.count).toBe(0);
    expect(result.missedOrderLine).toBeUndefined();
    expect(result.instruction).toMatch(/no confirma que no lo tengamos/i);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('turno de reserva no identifica líneas de pedido', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: {
        reservation_agent_active: true,
        ...queue([{ id: 'l1', hint: 'lomo', requestedQuantity: 1, status: 'active' }]),
      },
    });

    const result = JSON.parse((await callSearch('lomo')) as string);

    expect(result.missedOrderLine).toBeUndefined();
    expect(result.instruction).toMatch(/Turno de reserva/);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('reformulación exitosa: una segunda búsqueda con otro término resuelve la misma línea', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: queue([
        { id: 'l1', hint: 'cevichito', requestedQuantity: null, status: 'active' },
      ]),
    });

    const miss = JSON.parse((await callSearch('cevichito')) as string);
    expect(miss.count).toBe(0);
    expect(miss.missedOrderLine).toEqual({ hint: 'cevichito' });
    expect(patchConversationMetadata).not.toHaveBeenCalled();

    // El cliente aclara "ceviche clásico" — la línea sigue intacta (nunca se
    // tocó), así que una búsqueda reformulada que SÍ matchea resuelve normal.
    searchMenuItemsByKeyword.mockResolvedValue([
      { id: 'cev-1', name: 'Ceviche Clásico', serves_people: 2 },
    ]);
    const resolved = JSON.parse((await callSearch('ceviche clasico')) as string);

    expect(resolved.count).toBe(1);
    expect(resolved.instruction).toBeUndefined();
    expect(resolved.items).toHaveLength(1);
  });

  it('sin coincidencias persistentes: la segunda búsqueda sin match sigue ofreciendo la misma salida, sin declarar inexistencia', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: queue([
        { id: 'l1', hint: 'cevichito', requestedQuantity: null, status: 'active' },
      ]),
    });

    const first = JSON.parse((await callSearch('cevichito')) as string);
    const second = JSON.parse((await callSearch('cevichito tipo tiradito')) as string);

    for (const result of [first, second]) {
      expect(result.missedOrderLine).toEqual({ hint: 'cevichito' });
      expect(result.instruction).toMatch(/confirme el nombre exacto|digas de qué se trata/i);
      expect(result.instruction).toMatch(/PROHIBIDO decir "no lo tenemos"/);
    }
    // Ningún intento, por repetido que sea, escribió metadata ni canceló nada:
    // la "salida explícita" es conversacional (reformular / seguir con el
    // resto / cancel_order_line a pedido), no un contador de intentos nuevo.
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('error técnico: la búsqueda que falla no se interpreta como indisponibilidad ni toca la cola', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: queue([
        { id: 'l1', hint: 'cevichito', requestedQuantity: null, status: 'active' },
      ]),
    });
    searchMenuItemsByKeyword.mockRejectedValue(new Error('embedding service unavailable'));

    await expect(callSearch('cevichito')).rejects.toThrow('embedding service unavailable');
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
