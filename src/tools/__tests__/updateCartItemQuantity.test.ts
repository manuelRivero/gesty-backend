/**
 * update_cart_item_quantity fija la cantidad FINAL de una línea existente.
 * No suma, no agrega otra línea y no borra.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    draft_order_item: {
      findMany: vi.fn(),
      update: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: {},
}));

import { updateCartItemQuantityTool } from '../index';
import { prisma } from '../../lib/prisma';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

const DRAFT = { id: 'draft-1' };
const ARROZ_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const AJI_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SUSPIRO_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const line = (
  id: string,
  name: string,
  quantity: number
) => ({
  id,
  variation: null,
  quantity,
  unit_price: 10000,
  notes: null,
  menu_item: { name },
});

const callTool = (input: { itemIndex?: number | string; quantity?: number | string }) =>
  updateCartItemQuantityTool.func(input, undefined, CONFIG);

const expectUntouched = () => {
  expect(prisma.draft_order_item.update).not.toHaveBeenCalled();
  expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
  expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
};

describe('update_cart_item_quantity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(DRAFT as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: 30000 },
    } as never);
    vi.mocked(prisma.draft_order_item.update).mockResolvedValue({} as never);
    vi.mocked(prisma.draft_order.update).mockResolvedValue({} as never);
  });

  it('fija la cantidad final de la línea 1 y deja la otra igual', async () => {
    vi.mocked(prisma.draft_order_item.findMany)
      .mockResolvedValueOnce([line(ARROZ_ID, 'Arroz con pollo', 1), line(AJI_ID, 'Ají de gallina', 1)] as never)
      .mockResolvedValueOnce([line(ARROZ_ID, 'Arroz con pollo', 2), line(AJI_ID, 'Ají de gallina', 1)] as never);

    const result = JSON.parse((await callTool({ itemIndex: 1, quantity: 2 })) as string);

    expect(result.success).toBe(true);
    expect(result.updated).toEqual({ itemIndex: 1, itemName: 'Arroz con pollo', quantity: 2 });
    expect(result.cart.items).toEqual([
      { itemIndex: 1, name: 'Arroz con pollo', variation: null, quantity: 2, notes: null },
      { itemIndex: 2, name: 'Ají de gallina', variation: null, quantity: 1, notes: null },
    ]);
    expect(prisma.draft_order_item.update).toHaveBeenCalledTimes(1);
    expect(prisma.draft_order_item.update).toHaveBeenCalledWith({
      where: { id: ARROZ_ID },
      data: { quantity: 2, total_price: expect.anything() },
    });
    const written = vi.mocked(prisma.draft_order_item.update).mock.calls[0][0].data.quantity;
    expect(written).toBe(2);
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
  });

  it('es idempotente: pedir 2 cuando ya hay 2 no termina en 4', async () => {
    vi.mocked(prisma.draft_order_item.findMany)
      .mockResolvedValueOnce([line(ARROZ_ID, 'Arroz con pollo', 2)] as never)
      .mockResolvedValueOnce([line(ARROZ_ID, 'Arroz con pollo', 2)] as never);

    const result = JSON.parse((await callTool({ itemIndex: 1, quantity: 2 })) as string);

    expect(result.success).toBe(true);
    expect(result.updated.quantity).toBe(2);
    expect(result.cart.items[0].quantity).toBe(2);
    expect(prisma.draft_order_item.update).toHaveBeenCalledWith({
      where: { id: ARROZ_ID },
      data: { quantity: 2, total_price: expect.anything() },
    });
  });

  it('no cambia las otras líneas', async () => {
    vi.mocked(prisma.draft_order_item.findMany)
      .mockResolvedValueOnce([
        line(ARROZ_ID, 'Arroz con pollo', 1),
        line(AJI_ID, 'Ají de gallina', 1),
        line(SUSPIRO_ID, 'Suspiro a la limeña', 1),
      ] as never)
      .mockResolvedValueOnce([
        line(ARROZ_ID, 'Arroz con pollo', 2),
        line(AJI_ID, 'Ají de gallina', 1),
        line(SUSPIRO_ID, 'Suspiro a la limeña', 1),
      ] as never);

    const result = JSON.parse((await callTool({ itemIndex: 1, quantity: 2 })) as string);

    expect(result.cart.items.map((it: { name: string; quantity: number }) => [it.name, it.quantity])).toEqual([
      ['Arroz con pollo', 2],
      ['Ají de gallina', 1],
      ['Suspiro a la limeña', 1],
    ]);
    expect(prisma.draft_order_item.update).toHaveBeenCalledTimes(1);
    expect(prisma.draft_order_item.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ARROZ_ID } })
    );
  });

  it('un índice inexistente no modifica el carrito', async () => {
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([
      line(ARROZ_ID, 'Arroz con pollo', 1),
    ] as never);

    const result = JSON.parse((await callTool({ itemIndex: 99, quantity: 2 })) as string);

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_item_index');
    expectUntouched();
  });

  it.each([0, -1, 1.5, 'dos'])('quantity inválida (%s) no modifica el carrito', async (quantity) => {
    const result = JSON.parse((await callTool({ itemIndex: 1, quantity })) as string);

    expect(result.success).toBe(false);
    expect(result.error).toBe('quantity_invalid');
    expect(prisma.draft_order.findFirst).not.toHaveBeenCalled();
    expectUntouched();
  });
});
