/**
 * Resolución de nombres dichos por el dueño contra el catálogo real (D3/D4).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    menu_item: { findMany: vi.fn() },
    business: { findUnique: vi.fn() },
  },
}));

vi.mock('../../menu.service', () => ({
  MenuService: { searchMenuItemsByKeyword: vi.fn() },
}));

vi.mock('../../../helpers/menuItemPrice.helper', () => ({
  activePriceSelect: () => ({ take: 1 }),
  getBusinessCurrencyCode: vi.fn().mockResolvedValue('ARS'),
}));

import { prisma } from '../../../lib/prisma';
import { MenuService } from '../../menu.service';
import { normalizeForMatch, resolveProductEntities } from '../resolveProductEntities';

const mockedFindMany = prisma.menu_item.findMany as unknown as ReturnType<typeof vi.fn>;
const mockedSemantic = MenuService.searchMenuItemsByKeyword as unknown as ReturnType<
  typeof vi.fn
>;

function catalogRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    name: 'Hamburguesa clásica',
    image: 'https://cdn/hamburguesa.jpg',
    variations: [],
    menu_item_price: [{ amount: 9500, currency_code: 'ARS' }],
    ...overrides,
  };
}

const entity = (text: string, path = 'offer.conditions[0].value.productName') => ({
  type: 'product' as const,
  text,
  path,
});

describe('normalizeForMatch', () => {
  it('quita acentos, mayúsculas y puntuación', () => {
    expect(normalizeForMatch('Papas Fritas, Grandes!')).toBe('papas fritas grandes');
    expect(normalizeForMatch('Ñoquis')).toBe('noquis');
  });
});

describe('resolveProductEntities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marca resolved con un único match exacto (ignorando acentos y plural)', async () => {
    mockedFindMany.mockResolvedValueOnce([
      catalogRow({ id: 'item-1', name: 'Papá Frita' }),
      catalogRow({ id: 'item-2', name: 'Pizza muzzarella' }),
    ]);

    const [result] = await resolveProductEntities({
      businessId: 'biz-1',
      entities: [entity('papas fritas')],
    });

    expect(result?.resolved).toBe(true);
    expect(result?.candidates[0]).toMatchObject({
      menuItemId: 'item-1',
      name: 'Papá Frita',
      source: 'exact',
      score: 1,
      thumbnailUrl: 'https://cdn/hamburguesa.jpg',
      price: 9500,
    });
    expect(mockedSemantic).not.toHaveBeenCalled();
  });

  it('no marca resolved si hay dos matches exactos', async () => {
    mockedFindMany.mockResolvedValueOnce([
      catalogRow({ id: 'item-1', name: 'Hamburguesa' }),
      catalogRow({ id: 'item-2', name: 'hamburguesas' }),
    ]);

    const [result] = await resolveProductEntities({
      businessId: 'biz-1',
      entities: [entity('hamburguesa')],
    });

    expect(result?.resolved).toBe(false);
    expect(result?.candidates).toHaveLength(2);
  });

  it('usa contains cuando no hay exacto y no llama al vector', async () => {
    mockedFindMany.mockResolvedValueOnce([
      catalogRow({ id: 'item-1', name: 'Hamburguesa clásica' }),
    ]);

    const [result] = await resolveProductEntities({
      businessId: 'biz-1',
      entities: [entity('hamburguesa')],
    });

    expect(result?.resolved).toBe(false);
    expect(result?.candidates[0]?.source).toBe('contains');
    expect(mockedSemantic).not.toHaveBeenCalled();
  });

  it('matchea por variación del platillo', async () => {
    mockedFindMany.mockResolvedValueOnce([
      catalogRow({
        id: 'item-1',
        name: 'Pizza',
        variations: ['Roquefort', 'Napolitana'],
      }),
    ]);

    const [result] = await resolveProductEntities({
      businessId: 'biz-1',
      entities: [entity('napolitana')],
    });

    expect(result?.resolved).toBe(true);
    expect(result?.candidates[0]?.matchedVariation).toBe('Napolitana');
  });

  it('cae al vector cuando el nombre no se parece a nada del catálogo', async () => {
    mockedFindMany.mockResolvedValueOnce([
      catalogRow({ id: 'item-9', name: 'Bastones de papa rústicos' }),
    ]);
    mockedSemantic.mockResolvedValueOnce([{ id: 'item-9', distance: 0.2 }]);

    const [result] = await resolveProductEntities({
      businessId: 'biz-1',
      entities: [entity('fritas')],
    });

    expect(mockedSemantic).toHaveBeenCalledWith({
      businessId: 'biz-1',
      keyword: 'fritas',
    });
    expect(result?.resolved).toBe(false);
    expect(result?.candidates[0]).toMatchObject({
      menuItemId: 'item-9',
      source: 'semantic',
      score: 0.8,
    });
  });

  it('degrada sin candidatos si el vector falla (sin cuota / sin embeddings)', async () => {
    mockedFindMany.mockResolvedValueOnce([catalogRow({ name: 'Ravioles' })]);
    mockedSemantic.mockRejectedValueOnce(new Error('no quota'));

    const [result] = await resolveProductEntities({
      businessId: 'biz-1',
      entities: [entity('sushi')],
    });

    expect(result?.candidates).toEqual([]);
    expect(result?.resolved).toBe(false);
  });

  it('no toca la base si no hay entidades de producto', async () => {
    const results = await resolveProductEntities({
      businessId: 'biz-1',
      entities: [{ type: 'category', text: 'bebidas', path: 'offer.x' }],
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.candidates).toEqual([]);
    expect(mockedFindMany).not.toHaveBeenCalled();
  });

  it('filtra por negocio y disponibilidad al cargar el catálogo', async () => {
    mockedFindMany.mockResolvedValueOnce([catalogRow()]);

    await resolveProductEntities({
      businessId: 'biz-1',
      entities: [entity('hamburguesa clasica')],
    });

    expect(mockedFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { business_id: 'biz-1', is_available: true },
      })
    );
  });
});
