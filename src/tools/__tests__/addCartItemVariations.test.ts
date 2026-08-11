/**
 * Fase 5, Tarea 5.2 (PLAN-ACCION-VARIACIONES-PLATILLOS.md): gate de
 * variaciones en `add_cart_item`. D5 — la tool nunca escribe en el carrito
 * un producto con variaciones sin una variación válida.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    menu_item: {
      findFirst: vi.fn(),
    },
    draft_order_item: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
    business: {
      findUnique: vi.fn(),
    },
    conversation_state: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: {},
}));

vi.mock('../../services/draftOrderTimeout.service', () => ({
  refreshDraftOrderTimeout: vi.fn(),
}));

vi.mock('../../services/lastOffer.service', () => ({
  clearLastOffer: vi.fn(),
}));

vi.mock('../../services/pendingVariation.service', () => ({
  setPendingVariation: vi.fn(),
  clearPendingVariation: vi.fn(),
}));

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn(),
  omitConversationMetadataKeys: vi.fn(),
}));

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: vi.fn().mockResolvedValue({ metadata: {} }),
  };
});

vi.mock('../../services/pendingAddQuantity.service', () => ({
  setPendingAddQuantity: vi.fn(),
  clearPendingAddQuantity: vi.fn(),
  buildPendingAddQuantityMessage: vi.fn().mockReturnValue('¿Cuántas?'),
}));

vi.mock('../../services/orderCompletionGoal.service', () => ({
  getOrderCompletionLedger: vi.fn(),
  recordOrderCompletionAbandonment: vi.fn(),
  reviveOrderCompletionIfAbandoned: vi.fn(),
}));

import { addCartItemTool } from '../index';
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
const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';

const menuItem = (variations: string[]) => ({
  id: PRODUCT_ID,
  name: 'Pizza',
  discount_type: null,
  discount_value: null,
  variations,
  menu_item_price: [{ amount: new Prisma.Decimal(1000), currency_code: 'ARS' }],
});

const callTool = (input: { productId: string; quantity?: number; variation?: string }) =>
  addCartItemTool.func({ quantity: 1, ...input }, undefined, CONFIG);

describe('add_cart_item — gate de variaciones (Fase 5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue(DRAFT as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: new Prisma.Decimal(1000) },
    } as never);
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({ metadata: {} } as never);
  });

  it('producto con variaciones y sin variation: no escribe y devuelve variation_required', async () => {
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(
      menuItem(['Especial', 'Roquefort']) as never
    );

    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: 'variation_required',
        productName: 'Pizza',
        variations: ['Especial', 'Roquefort'],
      })
    );
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    expect(prisma.draft_order_item.update).not.toHaveBeenCalled();
  });

  it('con variation válida: escribe con la grafía canónica del catálogo', async () => {
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(
      menuItem(['Especial', 'Roquefort']) as never
    );
    vi.mocked(prisma.draft_order_item.findFirst).mockResolvedValue(null as never);

    const raw = await callTool({ productId: PRODUCT_ID, variation: 'roquefor' });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(true);
    expect(result.added.variation).toBe('Roquefort');
    expect(prisma.draft_order_item.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ variation: 'Roquefort' }) })
    );
  });

  it('con variación inexistente: devuelve variation_invalid y no escribe', async () => {
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(
      menuItem(['Especial', 'Roquefort']) as never
    );

    const raw = await callTool({ productId: PRODUCT_ID, variation: 'cuatro quesos' });
    const result = JSON.parse(raw as string);

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: 'variation_invalid',
        variations: ['Especial', 'Roquefort'],
      })
    );
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
  });

  it('dos variaciones distintas del mismo producto crean dos líneas', async () => {
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(
      menuItem(['Especial', 'Roquefort']) as never
    );
    // Cada llamado busca la línea existente con esa variación puntual — ninguna existe todavía.
    vi.mocked(prisma.draft_order_item.findFirst).mockResolvedValue(null as never);

    await callTool({ productId: PRODUCT_ID, variation: 'Especial' });
    await callTool({ productId: PRODUCT_ID, variation: 'Roquefort' });

    expect(prisma.draft_order_item.create).toHaveBeenCalledTimes(2);
    expect(prisma.draft_order_item.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ variation: 'Especial' }),
      })
    );
    expect(prisma.draft_order_item.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ variation: 'Roquefort' }),
      })
    );
  });

  it('producto sin variaciones: comportamiento idéntico al actual (no-regresión)', async () => {
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(menuItem([]) as never);
    vi.mocked(prisma.draft_order_item.findFirst).mockResolvedValue(null as never);

    const raw = await callTool({ productId: PRODUCT_ID });
    const result = JSON.parse(raw as string);

    expect(result.success).toBe(true);
    expect(result.added.variation).toBeNull();
    expect(prisma.draft_order_item.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ variation: null }) })
    );
  });
});
