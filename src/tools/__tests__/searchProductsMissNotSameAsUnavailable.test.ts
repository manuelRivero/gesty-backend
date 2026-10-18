/**
 * Fase 2 (continuidad de pedidos compuestos) — regresión del caso auditado:
 * "cero coincidencias de búsqueda" para una OrderLine activa YA NO equivale a
 * "producto confirmado no disponible". Este archivo documentaba el defecto
 * (auto-cancelación en el primer miss); ahora confirma el fix con el mismo
 * escenario exacto del incidente ("cevichito" sin match de catálogo, cola con
 * una segunda línea hermana).
 *
 * Reutiliza el mismo límite de mockeo que searchProductsMissedLine.test.ts
 * (infraestructura: MenuService, repositorio de conversation_state) para
 * ejercer el camino real: searchProductsTool.func → resolveMissedSearchOrderLine
 * (solo identifica, ya no cancela).
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
  omitConversationMetadataKeys: (...args: unknown[]) => omitConversationMetadataKeys(...args),
}));

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: (...args: unknown[]) => findOrCreateConversationState(...args),
    patchConversationMetadata: (...args: unknown[]) => patchConversationMetadata(...args),
    omitConversationMetadataKeys: (...args: unknown[]) => omitConversationMetadataKeys(...args),
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
    sourceMessage: 'un cevichito y unas papas a la huancaína',
    createdAt: '2026-10-18T04:00:00.000Z',
  },
});

const callSearch = (keyword: string) =>
  searchProductsTool.func({ keyword } as never, undefined, CONFIG);

describe('search_products: miss de keyword vs. no disponibilidad confirmada', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchConversationMetadata.mockResolvedValue(undefined);
    omitConversationMetadataKeys.mockResolvedValue(undefined);
  });

  it('un diminutivo/sinónimo que no matchea ("cevichito") YA NO cierra la línea: queda abierta, sin tocar las hermanas', async () => {
    // El catálogo real sí tiene "Ceviche" — searchMenuItemsByKeyword([]) simula que
    // la keyword literal "cevichito" no matcheó nada, SIN que el negocio haya
    // confirmado indisponibilidad (no se consulta menu_item.is_available en este
    // camino en absoluto).
    // El hint de la cola es el término literal que el modelo capturó del
    // usuario ("cevichito"): plan_order_lines no lo normaliza al nombre del
    // catálogo. search_products busca después ESE MISMO término — el miss
    // ocurre en MenuService.searchMenuItemsByKeyword (retrieval contra el
    // catálogo real, que sí tiene "Ceviche"), no en el cruce hint↔keyword.
    searchMenuItemsByKeyword.mockResolvedValue([]);
    findOrCreateConversationState.mockResolvedValue({
      metadata: queue([
        { id: 'l1', hint: 'cevichito', requestedQuantity: null, status: 'active', currentResolutionId: null, pendingNote: null },
        { id: 'l2', hint: 'papas a la huancaína', requestedQuantity: null, status: 'queued', currentResolutionId: null, pendingNote: null },
      ]),
    });

    const result = JSON.parse((await callSearch('cevichito')) as string);

    // 1) La línea NO se cancela automáticamente: ni en el primer intento ni
    //    sin intervención del usuario. Cero resultados solo identifica cuál
    //    línea era (missedOrderLine), no la cierra.
    expect(result.missedOrderLine).toEqual({ hint: 'cevichito' });
    expect(result.lineClosed).toBeUndefined();
    expect(patchConversationMetadata).not.toHaveBeenCalled();

    // 2) El estado SÍ distingue "este término no matcheó" (recuperable) de
    //    "confirmado no disponible" (requiere un productId identificado —
    //    ver add_cart_item): la instrucción lo dice explícitamente y la línea
    //    sigue en su status original ('active'), no 'cancelled'.
    expect(result.instruction).toMatch(/NO confirma que no lo tengamos/i);

    // 3) Se conserva la posibilidad de reformular: ya no hay una prohibición
    //    de volver a buscar el plato.
    expect(result.instruction).not.toMatch(/PROHIBIDO volver a buscarla/);
    expect(result.instruction).toMatch(/confirme el nombre exacto/i);

    // 4) La línea hermana (papas) ni se menciona ni se toca: no hay cascada,
    //    ni tampoco un queueFollowUp artificial sobre una cola que no cerró.
    expect(result.queueFollowUp).toBeUndefined();
    expect(result.instruction).not.toMatch(/papas/i);
  });

  it('control: una búsqueda con 1 resultado NO cancela nada, aunque el nombre sea parcial', async () => {
    // Contraste: alcanza con que el catálogo devuelva algo, sin importar qué tan
    // literal fue el match, para que la línea nunca se toque. Cero resultados
    // nunca cancela (regla general), así que esto solo confirma que la
    // regresión de la búsqueda exitosa sigue intacta.
    searchMenuItemsByKeyword.mockResolvedValue([
      { id: 'cev-1', name: 'Ceviche Clásico', serves_people: 2 },
    ]);
    findOrCreateConversationState.mockResolvedValue({
      metadata: queue([
        { id: 'l1', hint: 'ceviche', requestedQuantity: null, status: 'active', currentResolutionId: null, pendingNote: null },
      ]),
    });

    const result = JSON.parse((await callSearch('cevichito')) as string);

    expect(result.missedOrderLine).toBeUndefined();
    expect(result.lineClosed).toBeUndefined();
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });
});
