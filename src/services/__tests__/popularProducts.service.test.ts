/**
 * Test de `getPopularMenuItems` (Tarea 3.1 de PLAN-ACCION-CALIDAD-CONVERSACIONAL.md).
 * Cubre D8: umbral mínimo no alcanzado, ítem popular pero ya no disponible
 * (sin precio activo) y camino feliz.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    menu_item: {
      findMany: vi.fn(),
    },
  },
}));

import { getPopularMenuItems } from '../popularProducts.service';
import { prisma } from '../../lib/prisma';

const queryRawMock = prisma.$queryRaw as unknown as ReturnType<typeof vi.fn>;
const findManyMock = prisma.menu_item.findMany as unknown as ReturnType<typeof vi.fn>;

describe('getPopularMenuItems', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('umbral no alcanzado (pocos productos distintos): significant=false, items vacío', async () => {
    queryRawMock.mockResolvedValue([
      { menu_item_id: 'p1', name: 'Ceviche', order_count: BigInt(2) },
    ]);

    const result = await getPopularMenuItems({ businessId: 'biz-1' });

    expect(result.significant).toBe(false);
    expect(result.items).toEqual([]);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it('umbral no alcanzado (pocas unidades totales aunque haya varios productos): significant=false', async () => {
    queryRawMock.mockResolvedValue([
      { menu_item_id: 'p1', name: 'Ceviche', order_count: BigInt(1) },
      { menu_item_id: 'p2', name: 'Lomo saltado', order_count: BigInt(1) },
      { menu_item_id: 'p3', name: 'Ají de gallina', order_count: BigInt(1) },
    ]);

    const result = await getPopularMenuItems({ businessId: 'biz-1' });

    expect(result.significant).toBe(false);
    expect(result.items).toEqual([]);
  });

  it('producto popular pero ya sin precio activo (no disponible hoy): se excluye del resultado', async () => {
    queryRawMock.mockResolvedValue([
      { menu_item_id: 'p1', name: 'Ceviche', order_count: BigInt(10) },
      { menu_item_id: 'p2', name: 'Lomo saltado', order_count: BigInt(8) },
      { menu_item_id: 'p3', name: 'Ají de gallina', order_count: BigInt(5) },
    ]);
    // Solo p1 y p3 siguen con precio activo; p2 quedó afuera del catálogo.
    findManyMock.mockResolvedValue([
      { id: 'p1', menu_item_price: [{ amount: { toString: () => '25.00' }, currency_code: 'PEN' }] },
      { id: 'p3', menu_item_price: [{ amount: { toString: () => '18.00' }, currency_code: 'PEN' }] },
    ]);

    const result = await getPopularMenuItems({ businessId: 'biz-1' });

    expect(result.significant).toBe(true);
    expect(result.items.map((i) => i.id)).toEqual(['p1', 'p3']);
  });

  it('camino feliz: devuelve items ordenados por popularidad con precio', async () => {
    queryRawMock.mockResolvedValue([
      { menu_item_id: 'p1', name: 'Ceviche', order_count: BigInt(20) },
      { menu_item_id: 'p2', name: 'Lomo saltado', order_count: BigInt(15) },
      { menu_item_id: 'p3', name: 'Ají de gallina', order_count: BigInt(10) },
    ]);
    findManyMock.mockResolvedValue([
      { id: 'p1', menu_item_price: [{ amount: { toString: () => '25.00' }, currency_code: 'PEN' }] },
      { id: 'p2', menu_item_price: [{ amount: { toString: () => '22.00' }, currency_code: 'PEN' }] },
      { id: 'p3', menu_item_price: [{ amount: { toString: () => '18.00' }, currency_code: 'PEN' }] },
    ]);

    const result = await getPopularMenuItems({ businessId: 'biz-1', limit: 2 });

    expect(result.significant).toBe(true);
    expect(result.items).toEqual([
      { id: 'p1', name: 'Ceviche', orderCount: 20, prices: [{ amount: '25.00', currency: 'PEN' }] },
      { id: 'p2', name: 'Lomo saltado', orderCount: 15, prices: [{ amount: '22.00', currency: 'PEN' }] },
    ]);
  });

  it('sin ventas: significant=false', async () => {
    queryRawMock.mockResolvedValue([]);
    const result = await getPopularMenuItems({ businessId: 'biz-1' });
    expect(result.significant).toBe(false);
    expect(result.items).toEqual([]);
  });
});
