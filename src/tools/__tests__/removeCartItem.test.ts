/**
 * remove_cart_item borra la línea del itemIndex en el mismo llamado.
 * prisma se mockea para no requerir BD.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    draft_order_item: {
      findFirst: vi.fn(),
      delete: vi.fn(),
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
    conversation_state: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn(),
  omitConversationMetadataKeys: vi.fn(),
}));

// tools/index.ts importa el módulo completo de tools (incluye MenuService, que
// instancia un cliente OpenAI al cargar) — se mockea para no requerir API keys.
vi.mock('../../services/menu.service', () => ({
  MenuService: {},
}));

import { removeCartItemTool } from '../index';
import { prisma } from '../../lib/prisma';
import {
  patchConversationMetadata,
  omitConversationMetadataKeys,
} from '../../repositories/conversationState.repository';

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
const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';
const LINE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_LINE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const LINE = {
  id: LINE_ID,
  product_id: PRODUCT_ID,
  variation: null,
  quantity: 2,
  menu_item: { id: PRODUCT_ID, name: 'Milanesa' },
};

const callTool = (input: { itemIndex?: number | string }) =>
  removeCartItemTool.func(input, undefined, CONFIG);

describe('remove_cart_item — borrado directo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(DRAFT as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: null },
    } as never);
  });

  it('elimina la línea en el primer llamado, sin pedir confirmación', async () => {
    vi.mocked(prisma.draft_order_item.findMany)
      .mockResolvedValueOnce([LINE] as never)
      .mockResolvedValueOnce([] as never);

    const result = JSON.parse((await callTool({ itemIndex: 1 })) as string);

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBeUndefined();
    expect(result.removed).toEqual({ itemName: 'Milanesa', quantity: 2 });
    expect(result.followUp?.nextAction).toBe('present_cart');
    expect(prisma.draft_order_item.delete).toHaveBeenCalledWith({ where: { id: LINE_ID } });
    expect(prisma.draft_order.update).toHaveBeenCalledWith({
      where: { id: DRAFT.id },
      data: { total_amount: expect.anything() },
    });
    expect(patchConversationMetadata).not.toHaveBeenCalled();
    expect(omitConversationMetadataKeys).not.toHaveBeenCalled();
  });
});

describe('remove_cart_item — varias líneas del mismo plato (variaciones)', () => {
  const ESPECIAL = { ...LINE, id: LINE_ID, variation: 'Especial' };
  const ROQUEFORT = { ...LINE, id: OTHER_LINE_ID, variation: 'Roquefort' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(DRAFT as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: null },
    } as never);
  });

  it('itemIndex 2 borra esa variación y no la otra', async () => {
    vi.mocked(prisma.draft_order_item.findMany)
      .mockResolvedValueOnce([ESPECIAL, ROQUEFORT] as never)
      .mockResolvedValueOnce([ESPECIAL] as never);

    const result = JSON.parse((await callTool({ itemIndex: 2 })) as string);

    expect(result.success).toBe(true);
    expect(result.removed.itemName).toBe('Milanesa (Roquefort)');
    expect(prisma.draft_order_item.delete).toHaveBeenCalledWith({ where: { id: OTHER_LINE_ID } });
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalledWith({ where: { id: LINE_ID } });
  });
});

describe('remove_cart_item — itemIndex 1-based', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(DRAFT as never);
  });

  it('itemIndex fuera de rango no borra y lista los índices', async () => {
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([LINE] as never);

    const result = JSON.parse((await callTool({ itemIndex: 99 })) as string);

    expect(result.success).toBe(false);
    expect(result.error).toBe('invalid_item_index');
    expect(result.cartLineCount).toBe(1);
    expect(result.lines[0].itemIndex).toBe(1);
    expect(result.message).toMatch(/fuera de rango/);
    expect(result.message).toMatch(/itemIndex 1 = Milanesa/);
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
  });

  it('sin itemIndex no borra y pide el número del estado', async () => {
    const parsed = removeCartItemTool.schema.safeParse({});
    expect(parsed.success).toBe(true);

    const result = JSON.parse((await callTool({})) as string);

    expect(result.success).toBe(false);
    expect(result.error).toBe('item_index_required');
    expect(result.message).toBe(
      'Error: No indicaste el itemIndex. Usá el número de la lista del carrito en [ESTADO DEL CLIENTE] (1, 2, 3…) y volvé a llamar remove_cart_item solo con ese itemIndex. No pases id ni nombre.'
    );
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
  });

  it('itemIndex no numérico no borra y pide corrección', async () => {
    const result = JSON.parse((await callTool({ itemIndex: 'aji' })) as string);

    expect(result.success).toBe(false);
    expect(result.error).toBe('item_index_invalid');
    expect(result.message).toMatch(/\[ESTADO DEL CLIENTE\]/);
    expect(prisma.draft_order_item.findMany).not.toHaveBeenCalled();
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
  });
});
