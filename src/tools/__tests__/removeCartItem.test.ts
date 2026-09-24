/**
 * remove_cart_item borra en el acto cuando el modelo la llama.
 * La ambigüedad de variaciones sigue sin borrar: devuelve candidatos.
 *
 * prisma y el repositorio de conversation_state se mockean para no requerir BD.
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

const callTool = (input: { productId: string; draftOrderItemId?: string }) =>
  removeCartItemTool.func(input, undefined, CONFIG);

describe('remove_cart_item — borrado directo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(DRAFT as never);
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([LINE] as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: null },
    } as never);
  });

  it('elimina la línea en el primer llamado, sin confirmación previa', async () => {
    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(true);
    expect(result.requiresConfirmation).toBeUndefined();
    expect(result.followUp?.nextAction).toBe('present_cart');
    expect(prisma.draft_order_item.delete).toHaveBeenCalledWith({ where: { id: LINE_ID } });
    expect(prisma.draft_order.update).toHaveBeenCalledWith({
      where: { id: DRAFT.id },
      data: { total_amount: expect.anything() },
    });
    expect(patchConversationMetadata).not.toHaveBeenCalled();
    expect(omitConversationMetadataKeys).toHaveBeenCalledWith('conv-1', [
      'pendingAction',
      'pendingItemId',
      'pendingItemName',
      'pendingActionAt',
    ]);
  });
});

/**
 * Con variaciones un producto ocupa varias líneas: borrar "la primera que
 * devuelva la query" elimina una arbitraria. Mismo contrato que
 * `update_item_note`: candidatos, no adivinanza.
 */
describe('remove_cart_item — varias líneas del mismo plato (variaciones)', () => {
  const ESPECIAL = { ...LINE, id: LINE_ID, variation: 'Especial' };
  const ROQUEFORT = { ...LINE, id: OTHER_LINE_ID, variation: 'Roquefort' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(DRAFT as never);
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({ metadata: {} } as never);
  });

  it('con solo productId y dos líneas devuelve los candidatos sin borrar ni preguntar por una', async () => {
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([ESPECIAL, ROQUEFORT] as never);

    const result = JSON.parse((await callTool({ productId: PRODUCT_ID })) as string);

    expect(result.success).toBe(false);
    expect(result.error).toBe('ambiguous_lines');
    expect(result.candidates).toEqual([
      {
        draftOrderItemId: LINE_ID,
        productId: PRODUCT_ID,
        name: 'Milanesa',
        variation: 'Especial',
        quantity: 2,
      },
      {
        draftOrderItemId: OTHER_LINE_ID,
        productId: PRODUCT_ID,
        name: 'Milanesa',
        variation: 'Roquefort',
        quantity: 2,
      },
    ]);
    expect(prisma.draft_order_item.delete).not.toHaveBeenCalled();
    // No deja pending: todavía no se sabe por cuál ítem preguntar.
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('con draftOrderItemId borra esa línea y nombra la variación', async () => {
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([ROQUEFORT] as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: null },
    } as never);

    const result = JSON.parse(
      (await callTool({ productId: PRODUCT_ID, draftOrderItemId: OTHER_LINE_ID })) as string
    );

    expect(result.success).toBe(true);
    expect(result.removed.itemName).toBe('Milanesa (Roquefort)');
    expect(prisma.draft_order_item.delete).toHaveBeenCalledWith({ where: { id: OTHER_LINE_ID } });
    expect(patchConversationMetadata).not.toHaveBeenCalled();
  });

  it('borra la línea pedida y no la otra variación', async () => {
    vi.mocked(prisma.draft_order_item.findMany)
      .mockResolvedValueOnce([ROQUEFORT] as never)
      .mockResolvedValueOnce([ESPECIAL] as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: null },
    } as never);

    const result = JSON.parse(
      (await callTool({ productId: PRODUCT_ID, draftOrderItemId: OTHER_LINE_ID })) as string
    );

    expect(result.success).toBe(true);
    expect(result.removed.itemName).toBe('Milanesa (Roquefort)');
    expect(prisma.draft_order_item.delete).toHaveBeenCalledWith({ where: { id: OTHER_LINE_ID } });
  });
});
