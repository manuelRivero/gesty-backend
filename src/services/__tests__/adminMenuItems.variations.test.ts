/**
 * Fase 3 (PLAN-ACCION-VARIACIONES-PLATILLOS.md): CRUD admin de variaciones
 * de nombre de un platillo. Cubre normalización al persistir, semántica de
 * `undefined` vs `null` en el update, serialización `[] → null` y el
 * disparo del refresh de embedding.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    menu_item: {
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
    },
    menu_category: {
      findFirst: vi.fn(),
    },
    business: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../ai/menuItemEmbedding.service', () => ({
  refreshMenuItemEmbedding: vi.fn().mockResolvedValue({ updated: true }),
}));

import { prisma } from '../../lib/prisma';
import { refreshMenuItemEmbedding } from '../ai/menuItemEmbedding.service';
import { createAdminMenuItem, updateAdminMenuItem } from '../adminMenuItems.service';

const mockedCreate = prisma.menu_item.create as unknown as ReturnType<typeof vi.fn>;
const mockedUpdate = prisma.menu_item.update as unknown as ReturnType<typeof vi.fn>;
const mockedFindFirst = prisma.menu_item.findFirst as unknown as ReturnType<typeof vi.fn>;
const mockedCategoryFindFirst = prisma.menu_category.findFirst as unknown as ReturnType<
  typeof vi.fn
>;
const mockedBusinessFindUnique = prisma.business.findUnique as unknown as ReturnType<
  typeof vi.fn
>;
const mockedRefreshEmbedding = refreshMenuItemEmbedding as unknown as ReturnType<typeof vi.fn>;

const baseRow = {
  id: 'item-1',
  business_id: 'biz-1',
  category_id: 'cat-1',
  name: 'Pizza',
  description: null,
  ingredients: null,
  preparation: null,
  is_available: true,
  serves_people: null,
  is_featured: false,
  ingredients_notes: null,
  image: null,
  image_key: null,
  discount_type: null,
  discount_value: null,
  variations: [] as string[],
  menu_category: { id: 'cat-1', name: 'Pizzas', category_tag: 'MAIN' },
  menu_item_price: [],
};

describe('adminMenuItems.service — variaciones (Fase 3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedCategoryFindFirst.mockResolvedValue({ id: 'cat-1' });
    mockedBusinessFindUnique.mockResolvedValue({ currency_code: 'ARS' });
    mockedFindFirst.mockResolvedValue(baseRow);
  });

  it('crear normaliza y persiste las variaciones', async () => {
    mockedCreate.mockResolvedValueOnce({ id: 'item-1' });

    await createAdminMenuItem({
      businessId: 'biz-1',
      categoryId: 'cat-1',
      name: 'Pizza',
      variations: ['Especial', 'especial', '  Roquefort  ', ''],
    });

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          variations: ['Especial', 'Roquefort'],
        }),
      })
    );
  });

  it('crear sin variaciones dispara el refresh de embedding (no hay precio)', async () => {
    mockedCreate.mockResolvedValueOnce({ id: 'item-1' });

    await createAdminMenuItem({
      businessId: 'biz-1',
      categoryId: 'cat-1',
      name: 'Pizza',
    });

    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ variations: [] }) })
    );
    expect(mockedRefreshEmbedding).toHaveBeenCalledWith('item-1');
  });

  it('actualizar con variations undefined no toca la columna', async () => {
    mockedUpdate.mockResolvedValueOnce(baseRow);

    await updateAdminMenuItem({
      businessId: 'biz-1',
      id: 'item-1',
      name: 'Pizza grande',
    });

    expect(mockedUpdate.mock.calls[0][0].data).not.toHaveProperty('variations');
  });

  it('actualizar con variations null limpia la columna', async () => {
    mockedUpdate.mockResolvedValueOnce(baseRow);

    await updateAdminMenuItem({
      businessId: 'biz-1',
      id: 'item-1',
      variations: null,
    });

    expect(mockedUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ variations: [] }) })
    );
  });

  it('un cambio de variations dispara refreshMenuItemEmbedding en el update', async () => {
    mockedUpdate.mockResolvedValueOnce(baseRow);

    await updateAdminMenuItem({
      businessId: 'biz-1',
      id: 'item-1',
      variations: ['Napolitana'],
    });

    expect(mockedRefreshEmbedding).toHaveBeenCalledWith('item-1');
  });

  it('formatAdminMenuItem devuelve null cuando variations está vacío', async () => {
    mockedFindFirst.mockResolvedValue({ ...baseRow, variations: [] });
    mockedUpdate.mockResolvedValueOnce(baseRow);

    const result = await updateAdminMenuItem({
      businessId: 'biz-1',
      id: 'item-1',
      name: 'Pizza grande',
    });

    expect(result?.variations).toBeNull();
  });

  it('formatAdminMenuItem devuelve la lista cuando hay variaciones', async () => {
    mockedFindFirst.mockResolvedValue({ ...baseRow, variations: ['Especial', 'Roquefort'] });
    mockedUpdate.mockResolvedValueOnce(baseRow);

    const result = await updateAdminMenuItem({
      businessId: 'biz-1',
      id: 'item-1',
      name: 'Pizza grande',
    });

    expect(result?.variations).toEqual(['Especial', 'Roquefort']);
  });
});
