/**
 * Tools informativas en turno de dominio reserva: devuelven el dato del menú y
 * NO siembran estado de pedido.
 *
 * Evidencia 21/9: “¿tienen ceviche?” mid-reserva → `search_products` escribió
 * `pendingProductSelection` + candidatos y ordenó `present_product_cta`; dos turnos
 * después el modelo sumó *1× Ceviche Clásico* al carrito sin que nadie lo pidiera.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const searchMenuItemsByKeyword = vi.fn();
const findUniqueBusiness = vi.fn();
const countMenuItems = vi.fn();
const findManyMenuItems = vi.fn();
const findOrCreateConversationState = vi.fn();
const patchConversationMetadata = vi.fn();

vi.mock('../../lib/prisma', () => ({
  prisma: {
    business: { findUnique: (...args: unknown[]) => findUniqueBusiness(...args) },
    menu_item: {
      count: (...args: unknown[]) => countMenuItems(...args),
      findMany: (...args: unknown[]) => findManyMenuItems(...args),
    },
  },
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: {
    searchMenuItemsByKeyword: (...args: unknown[]) => searchMenuItemsByKeyword(...args),
  },
}));

vi.mock('../../repositories/conversationState.repository', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../repositories/conversationState.repository')>();
  return {
    ...actual,
    patchConversationMetadata: (...args: unknown[]) => patchConversationMetadata(...args),
  };
});

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: (...args: unknown[]) =>
      findOrCreateConversationState(...args),
  };
});

import { searchProductsTool, findProductsByFilterTool } from '../index';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const CEVICHES = [
  { id: 'p1', name: 'Ceviche Clásico', serves_people: 2 },
  { id: 'p2', name: 'Ceviche con variaciones', serves_people: 1 },
];

const callSearch = () =>
  searchProductsTool.func({ keyword: 'ceviche' } as never, undefined, CONFIG);

const callFilter = () =>
  findProductsByFilterTool.func(
    { limit: 10, categoryTag: 'MAIN' } as never,
    undefined,
    CONFIG
  );

describe('search_products en turno de reserva', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    searchMenuItemsByKeyword.mockResolvedValue(CEVICHES);
  });

  it('no siembra pendingProductSelection y pide responder el dato', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: { reservation_agent_active: true },
    });

    const result = JSON.parse((await callSearch()) as string);

    expect(result.count).toBe(2);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
    expect(result.instruction).toMatch(/Turno de reserva/);
    expect(result.instruction).not.toMatch(/present_product_cta/);
  });

  it('en turno de pedido sigue sembrando el shortlist y pidiendo el CTA', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: { peopleCount: 2, requestedPartySize: 2 },
    });

    const result = JSON.parse((await callSearch()) as string);

    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        pendingProductSelection: true,
        candidateProductIds: ['p1', 'p2'],
      })
    );
    expect(result.instruction).toMatch(/present_product_cta\(SELECT_FROM_LIST\)/);
  });
});

describe('find_products_by_filter en turno de reserva', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueBusiness.mockResolvedValue({ currency_code: 'ARS' });
    countMenuItems.mockResolvedValue(2);
    findManyMenuItems.mockResolvedValue(
      CEVICHES.map((item) => ({ ...item, menu_category: null, menu_item_price: [] }))
    );
  });

  it('no siembra pendingProductSelection', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: { reservation_agent_active: true },
    });

    const result = JSON.parse((await callFilter()) as string);

    expect(result.count).toBe(2);
    expect(patchConversationMetadata).not.toHaveBeenCalled();
    expect(result.instruction).toMatch(/Turno de reserva/);
  });
});
