import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    business: { findUnique: vi.fn() },
    menu_item_price: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

vi.mock('../ai/openai.service', () => ({
  getProductEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
}));

import { prisma } from '../../lib/prisma';
import { MenuService } from '../menu.service';

describe('searchMenuItemsByKeyword price hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.business.findUnique).mockResolvedValue({
      currency_code: 'ARS',
    } as never);
  });

  it('adjunta precio activo distinto por producto del shortlist RAG', async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      {
        id: 'starter-100',
        name: 'Ceviche Clásico',
        description: null,
        ingredients: null,
        serves_people: 2,
        is_available: true,
        image: null,
        variations: [],
        distance: 0.1,
        category_id: 'cat-1',
        category_name: 'Ceviches',
        category_tag: 'STARTER',
      },
      {
        id: 'main-25000',
        name: 'Ceviche clasico con variaciones',
        description: null,
        ingredients: null,
        serves_people: 1,
        is_available: true,
        image: null,
        variations: ['muy picante'],
        distance: 0.12,
        category_id: 'cat-2',
        category_name: 'Marinos y ceviches',
        category_tag: 'MAIN',
      },
    ] as never);

    vi.mocked(prisma.menu_item_price.findMany).mockResolvedValue([
      {
        menu_item_id: 'main-25000',
        amount: new Prisma.Decimal('25000'),
        currency_code: 'ARS',
      },
      {
        menu_item_id: 'starter-100',
        amount: new Prisma.Decimal('100'),
        currency_code: 'ARS',
      },
    ] as never);

    const items = await MenuService.searchMenuItemsByKeyword({
      businessId: 'biz-1',
      keyword: 'ceviche clasico',
    });

    expect(items).toHaveLength(2);
    expect(items[0]!.menu_item_price[0]?.amount.toString()).toBe('100');
    expect(items[1]!.menu_item_price[0]?.amount.toString()).toBe('25000');
    expect(prisma.menu_item_price.findMany).toHaveBeenCalled();
  });
});
