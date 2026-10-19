/**
 * get_products_details_by_ids: hidrata detalle completo de productos ya
 * shortlistados. Cubre los campos reales del catálogo (incluidos
 * `preparation`/`ingredients_notes`, agregados para enriquecer respuestas
 * informativas) y el descuento, cuando corresponde, reusando la misma fuente
 * de verdad que el carrito (`resolveEffectivePrice`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const findUniqueBusiness = vi.fn();
const findManyMenuItems = vi.fn();

vi.mock('../../lib/prisma', () => ({
  prisma: {
    business: { findUnique: (...args: unknown[]) => findUniqueBusiness(...args) },
    menu_item: { findMany: (...args: unknown[]) => findManyMenuItems(...args) },
  },
}));

import { getProductsDetailsByIdsTool } from '../index';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';

const baseItem = (overrides: Record<string, unknown> = {}) => ({
  id: PRODUCT_ID,
  name: 'Ceviche Clásico',
  description: 'Pescado fresco marinado en limón.',
  ingredients: 'Pescado, limón, cebolla, cilantro',
  preparation: 'Se macera el pescado en limón por 10 minutos.',
  ingredients_notes: 'Puede contener trazas de mariscos.',
  serves_people: 2,
  is_available: true,
  is_featured: false,
  variations: [],
  discount_type: null,
  discount_value: null,
  menu_category: { id: 'cat-1', name: 'Entradas', category_tag: 'STARTER' },
  menu_item_price: [{ amount: new Prisma.Decimal(1000), currency_code: 'ARS' }],
  ...overrides,
});

describe('get_products_details_by_ids', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUniqueBusiness.mockResolvedValue({ currency_code: 'ARS' });
  });

  it('devuelve nombre, precio, descripción, ingredientes y disponibilidad', async () => {
    findManyMenuItems.mockResolvedValue([baseItem()]);

    const result = JSON.parse(
      (await getProductsDetailsByIdsTool.func(
        { productIds: [PRODUCT_ID] },
        undefined,
        CONFIG
      )) as string
    );

    expect(result.count).toBe(1);
    const item = result.items[0];
    expect(item.id).toBe(PRODUCT_ID);
    expect(item.name).toBe('Ceviche Clásico');
    expect(item.description).toBe('Pescado fresco marinado en limón.');
    expect(item.ingredients).toBe('Pescado, limón, cebolla, cilantro');
    expect(item.is_available).toBe(true);
    expect(item.prices).toEqual([{ amount: '1000', currency: 'ARS' }]);
  });

  it('incluye preparation e ingredients_notes cuando tienen valor', async () => {
    findManyMenuItems.mockResolvedValue([baseItem()]);

    const result = JSON.parse(
      (await getProductsDetailsByIdsTool.func(
        { productIds: [PRODUCT_ID] },
        undefined,
        CONFIG
      )) as string
    );

    const item = result.items[0];
    expect(item.preparation).toBe('Se macera el pescado en limón por 10 minutos.');
    expect(item.ingredients_notes).toBe('Puede contener trazas de mariscos.');
  });

  it('representa preparation e ingredients_notes como null cuando no hay valor, sin inventar texto', async () => {
    findManyMenuItems.mockResolvedValue([
      baseItem({ preparation: null, ingredients_notes: null }),
    ]);

    const result = JSON.parse(
      (await getProductsDetailsByIdsTool.func(
        { productIds: [PRODUCT_ID] },
        undefined,
        CONFIG
      )) as string
    );

    const item = result.items[0];
    expect(item.preparation).toBeNull();
    expect(item.ingredients_notes).toBeNull();
  });

  it('no pierde variaciones ni categoría', async () => {
    findManyMenuItems.mockResolvedValue([
      baseItem({ variations: ['Clásico', 'Mixto'] }),
    ]);

    const result = JSON.parse(
      (await getProductsDetailsByIdsTool.func(
        { productIds: [PRODUCT_ID] },
        undefined,
        CONFIG
      )) as string
    );

    const item = result.items[0];
    expect(item.variations).toEqual(['Clásico', 'Mixto']);
    expect(item.category).toEqual({ id: 'cat-1', name: 'Entradas', tag: 'STARTER' });
  });

  it('omite variations cuando el producto no tiene (array vacío), igual que antes', async () => {
    findManyMenuItems.mockResolvedValue([baseItem({ variations: [] })]);

    const result = JSON.parse(
      (await getProductsDetailsByIdsTool.func(
        { productIds: [PRODUCT_ID] },
        undefined,
        CONFIG
      )) as string
    );

    expect('variations' in result.items[0]).toBe(false);
  });

  it('sin descuento configurado, el precio no trae discountedAmount ni discountAmount', async () => {
    findManyMenuItems.mockResolvedValue([
      baseItem({ discount_type: null, discount_value: null }),
    ]);

    const result = JSON.parse(
      (await getProductsDetailsByIdsTool.func(
        { productIds: [PRODUCT_ID] },
        undefined,
        CONFIG
      )) as string
    );

    const price = result.items[0].prices[0];
    expect(price).toEqual({ amount: '1000', currency: 'ARS' });
    expect('discountedAmount' in price).toBe(false);
    expect('discountAmount' in price).toBe(false);
  });

  it('con descuento PERCENT configurado, calcula el precio final con la misma lógica que el carrito', async () => {
    findManyMenuItems.mockResolvedValue([
      baseItem({
        discount_type: 'PERCENT',
        discount_value: new Prisma.Decimal(15),
      }),
    ]);

    const result = JSON.parse(
      (await getProductsDetailsByIdsTool.func(
        { productIds: [PRODUCT_ID] },
        undefined,
        CONFIG
      )) as string
    );

    const price = result.items[0].prices[0];
    expect(price.amount).toBe('1000');
    expect(price.discountAmount).toBe('150');
    expect(price.discountedAmount).toBe('850');
  });

  it('con discount_value <= 0 no hay descuento aplicable (consistente con resolveEffectivePrice)', async () => {
    findManyMenuItems.mockResolvedValue([
      baseItem({
        discount_type: 'FIXED',
        discount_value: new Prisma.Decimal(0),
      }),
    ]);

    const result = JSON.parse(
      (await getProductsDetailsByIdsTool.func(
        { productIds: [PRODUCT_ID] },
        undefined,
        CONFIG
      )) as string
    );

    const price = result.items[0].prices[0];
    expect('discountedAmount' in price).toBe(false);
  });

  it('sin precio activo (menu_item_price vacío), no hay prices ni descuento inventado', async () => {
    findManyMenuItems.mockResolvedValue([baseItem({ menu_item_price: [] })]);

    const result = JSON.parse(
      (await getProductsDetailsByIdsTool.func(
        { productIds: [PRODUCT_ID] },
        undefined,
        CONFIG
      )) as string
    );

    expect(result.items[0].prices).toEqual([]);
  });

  it('mantiene el contrato existente: sin ids válidos devuelve count 0 sin tocar la base', async () => {
    const result = JSON.parse(
      (await getProductsDetailsByIdsTool.func(
        { productIds: ['   '] },
        undefined,
        CONFIG
      )) as string
    );

    expect(result).toEqual({ count: 0, items: [] });
    expect(findManyMenuItems).not.toHaveBeenCalled();
  });
});
