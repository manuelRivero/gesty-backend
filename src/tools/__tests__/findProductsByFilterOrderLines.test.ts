/**
 * find_products_by_filter con cola de pedido: no usar containsIngredient
 * recortado del hint de plato (evidencia: "papas a la huancaína" → filtro
 * "papa" → Ensalada de papa y huacatay).
 *
 * Hints de sección ("algo de beber") no disparan el gate: ahí el filtro /
 * present_category sí corresponde.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findUniqueBusiness = vi.fn();
const countMenuItems = vi.fn();
const findManyMenuItems = vi.fn();

vi.mock('../../lib/prisma', () => ({
  prisma: {
    business: { findUnique: (...args: unknown[]) => findUniqueBusiness(...args) },
    menu_item: {
      count: (...args: unknown[]) => countMenuItems(...args),
      findMany: (...args: unknown[]) => findManyMenuItems(...args),
    },
  },
}));

vi.mock('../../services/menu.service', () => ({ MenuService: {} }));

const findOrCreateConversationState = vi.fn();

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: (...args: unknown[]) =>
      findOrCreateConversationState(...args),
  };
});

import { findProductsByFilterTool } from '../index';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const papasQueue = {
  pendingOrderLines: {
    lines: [
      {
        id: 'l1',
        hint: 'papas a la huancaína',
        requestedQuantity: 2,
        status: 'active',
      },
    ],
    sourceMessage: '2 papas a la huancaína',
    createdAt: new Date().toISOString(),
  },
};

const callFilter = (input: Record<string, unknown>) =>
  findProductsByFilterTool.func(
    { limit: 10, ...input } as never,
    undefined,
    CONFIG
  );

describe('find_products_by_filter + cola de pedido', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('containsIngredient recortado del hint de plato → use_search_products', async () => {
    findOrCreateConversationState.mockResolvedValue({ metadata: papasQueue });

    const result = JSON.parse(
      (await callFilter({ containsIngredient: 'papa' })) as string
    );

    expect(result.error).toBe('use_search_products');
    expect(result.keyword).toBe('papas a la huancaína');
    expect(result.instruction).toMatch(/search_products\(keyword="papas a la huancaína"\)/);
    expect(findUniqueBusiness).not.toHaveBeenCalled();
  });

  it('categoryTag sin recortar el hint no dispara el gate', async () => {
    findOrCreateConversationState.mockResolvedValue({ metadata: papasQueue });
    findUniqueBusiness.mockResolvedValue({ currency_code: 'ARS' });
    countMenuItems.mockResolvedValue(0);
    findManyMenuItems.mockResolvedValue([]);

    const result = JSON.parse(
      (await callFilter({ categoryTag: 'DRINK' })) as string
    );

    expect(result.error).toBeUndefined();
    expect(result.count).toBe(0);
    expect(findUniqueBusiness).toHaveBeenCalled();
  });

  it('hint de sección "algo de beber" + containsIngredient beber no bloquea', async () => {
    findOrCreateConversationState.mockResolvedValue({
      metadata: {
        pendingOrderLines: {
          lines: [
            {
              id: 'l1',
              hint: 'algo de beber',
              requestedQuantity: null,
              status: 'active',
            },
          ],
          sourceMessage: 'algo de beber',
          createdAt: new Date().toISOString(),
        },
      },
    });
    findUniqueBusiness.mockResolvedValue({ currency_code: 'ARS' });
    countMenuItems.mockResolvedValue(0);
    findManyMenuItems.mockResolvedValue([]);

    const result = JSON.parse(
      (await callFilter({ containsIngredient: 'beber' })) as string
    );

    expect(result.error).toBeUndefined();
    expect(findUniqueBusiness).toHaveBeenCalled();
  });
});
