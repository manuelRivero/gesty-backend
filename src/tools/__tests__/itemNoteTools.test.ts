import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn() },
    draft_order_item: { update: vi.fn() },
  },
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: {},
}));

vi.mock('../../services/pendingItemNote.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/pendingItemNote.service')>();
  return {
    ...actual,
    clearPendingItemNote: vi.fn(),
    setPendingItemNote: vi.fn(),
  };
});

import { prisma } from '../../lib/prisma';
import {
  clearPendingItemNote,
  setPendingItemNote,
} from '../../services/pendingItemNote.service';
import {
  clearPendingItemNoteTool,
  startItemNoteTool,
  updateItemNoteTool,
} from '../index';

const CONFIG = {
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-1',
    conversationStartedAt: new Date().toISOString(),
  },
};

describe('item note tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('start_item_note con 2 ítems setea pending sin productId', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      draft_order_item: [
        {
          product_id: '11111111-1111-1111-1111-111111111111',
          menu_item: { name: 'Chupe' },
        },
        {
          product_id: '22222222-2222-2222-2222-222222222222',
          menu_item: { name: 'Chicha' },
        },
      ],
    } as never);
    vi.mocked(setPendingItemNote).mockResolvedValue({
      askedAt: new Date().toISOString(),
      productId: null,
      productName: null,
      source: 'hybrid',
    });

    const raw = await startItemNoteTool.func({}, undefined, CONFIG);
    const parsed = JSON.parse(raw as string);
    expect(parsed.success).toBe(true);
    expect(parsed.askMessage).toMatch(/Qué querés anotar/i);
    expect(setPendingItemNote).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        productId: null,
        source: 'hybrid',
      })
    );
  });

  it('clear_pending_item_note limpia metadata', async () => {
    const raw = await clearPendingItemNoteTool.func({}, undefined, CONFIG);
    expect(JSON.parse(raw as string)).toEqual({ cleared: true });
    expect(clearPendingItemNote).toHaveBeenCalledWith('conv-1');
  });

  it('update_item_note exitoso limpia pendingItemNote', async () => {
    const productId = '11111111-1111-1111-1111-111111111111';
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      draft_order_item: [
        {
          id: 'line-1',
          product_id: productId,
          menu_item: { id: productId, name: 'Chupe' },
        },
      ],
    } as never);
    vi.mocked(prisma.draft_order_item.update).mockResolvedValue({} as never);

    const raw = await updateItemNoteTool.func(
      { productId, note: 'sin picante' },
      undefined,
      CONFIG
    );
    const parsed = JSON.parse(raw as string);
    expect(parsed.success).toBe(true);
    expect(clearPendingItemNote).toHaveBeenCalledWith('conv-1');
  });
});
