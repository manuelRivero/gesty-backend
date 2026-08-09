/**
 * Test del handler determinístico de RECOMMENDATION_REQUEST (Tarea 3.3 de
 * PLAN-ACCION-CALIDAD-CONVERSACIONAL.md). Cubre la cadena D9: destacados →
 * popularidad significativa → mensaje vacío.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../services/menu.service', () => ({
  MenuService: {
    getFeaturedMenuItemsPage: vi.fn(),
  },
}));

vi.mock('../../../../services/popularProducts.service', () => ({
  getPopularMenuItems: vi.fn(),
}));

import { RecommendationRequestHandler } from '../recommendationRequestHandler';
import { MenuService } from '../../../../services/menu.service';
import { getPopularMenuItems } from '../../../../services/popularProducts.service';
import type { EnrichedContext } from '../../types';

const handler = new RecommendationRequestHandler();

const ctx = {
  business: { id: 'biz-1', currency_code: 'PEN' },
  customer: { preferred_currency: null },
} as EnrichedContext;

describe('RecommendationRequestHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('con destacados: devuelve la lista de destacados y no consulta popularidad', async () => {
    vi.mocked(MenuService.getFeaturedMenuItemsPage).mockResolvedValue({
      items: [
        {
          id: 'p1',
          name: 'Ceviche',
          menu_item_price: [{ amount: { toString: () => '25.00' }, currency_code: 'PEN' }],
        },
      ],
      totalCount: 1,
      page: 1,
      totalPages: 1,
    } as never);

    const result = await handler.execute(ctx);

    expect(result?.isInteractive).toBe(true);
    expect(JSON.stringify(result?.content)).toMatch(/Destacados|Recomendaciones para vos/i);
    expect(JSON.stringify(result?.content)).toContain('SELECT_PRODUCT:p1');
    expect(getPopularMenuItems).not.toHaveBeenCalled();
  });

  it('sin destacados y con popularidad significativa: lista "Los más pedidos"', async () => {
    vi.mocked(MenuService.getFeaturedMenuItemsPage).mockResolvedValue({
      items: [],
      totalCount: 0,
      page: 1,
      totalPages: 1,
    } as never);
    vi.mocked(getPopularMenuItems).mockResolvedValue({
      significant: true,
      items: [
        {
          id: 'p2',
          name: 'Lomo saltado',
          orderCount: 20,
          prices: [{ amount: '22.00', currency: 'PEN' }],
        },
      ],
    });

    const result = await handler.execute(ctx);

    expect(result?.isInteractive).toBe(true);
    expect(JSON.stringify(result?.content)).toMatch(/Los más pedidos/i);
    expect(JSON.stringify(result?.content)).toContain('SELECT_PRODUCT:p2');
    expect(getPopularMenuItems).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: 'biz-1' })
    );
  });

  it('sin destacados y sin popularidad significativa: mensaje vacío actual', async () => {
    vi.mocked(MenuService.getFeaturedMenuItemsPage).mockResolvedValue({
      items: [],
      totalCount: 0,
      page: 1,
      totalPages: 1,
    } as never);
    vi.mocked(getPopularMenuItems).mockResolvedValue({
      significant: false,
      items: [],
    });

    const result = await handler.execute(ctx);

    expect(result?.isInteractive).toBe(false);
    expect(String(result?.content)).toMatch(/Todavía no tenemos destacados/i);
  });
});
