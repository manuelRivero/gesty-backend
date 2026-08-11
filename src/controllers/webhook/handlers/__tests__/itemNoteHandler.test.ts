import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationIntent } from '../../../../types/conversationIntent';

vi.mock('../../../../lib/prisma', () => ({
  prisma: {
    draft_order: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('../../../../services/pendingItemNote.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../services/pendingItemNote.service')>();
  return {
    ...actual,
    setPendingItemNote: vi.fn().mockResolvedValue({
      askedAt: new Date().toISOString(),
      source: 'payload',
    }),
  };
});

import { prisma } from '../../../../lib/prisma';
import { setPendingItemNote } from '../../../../services/pendingItemNote.service';
import { ItemNoteHandler } from '../itemNoteHandler';

describe('ItemNoteHandler', () => {
  const handler = new ItemNoteHandler();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('canHandle ITEM_NOTE', () => {
    expect(handler.canHandle(ConversationIntent.ITEM_NOTE)).toBe(true);
    expect(handler.canHandle(ConversationIntent.VIEW_CART)).toBe(false);
  });

  it('con 2 ítems: ask + pending sin productId', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      draft_order_item: [
        {
          product_id: '11111111-1111-1111-1111-111111111111',
          menu_item: { id: '11111111-1111-1111-1111-111111111111', name: 'Chupe' },
        },
        {
          product_id: '22222222-2222-2222-2222-222222222222',
          menu_item: { id: '22222222-2222-2222-2222-222222222222', name: 'Chicha' },
        },
      ],
    } as never);

    const result = await handler.execute({
      conversationId: 'conv-1',
      business: { id: 'biz-1' },
      customer: { phone_number: '54911' },
      to: '54911',
    } as never);

    expect(setPendingItemNote).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        productId: null,
        source: 'payload',
      })
    );
    expect(result?.isInteractive).toBe(false);
    expect(String(result?.content)).toMatch(/Qué querés anotar/i);
    expect(String(result?.content)).toMatch(/sobre cuál/i);
  });

  it('con 1 ítem: prellena productId', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      draft_order_item: [
        {
          product_id: '11111111-1111-1111-1111-111111111111',
          menu_item: { id: '11111111-1111-1111-1111-111111111111', name: 'Chicha' },
        },
      ],
    } as never);

    const result = await handler.execute({
      conversationId: 'conv-1',
      business: { id: 'biz-1' },
      customer: { phone_number: '54911' },
      to: '54911',
    } as never);

    expect(setPendingItemNote).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: '11111111-1111-1111-1111-111111111111',
        productName: 'Chicha',
        source: 'payload',
      })
    );
    expect(String(result?.content)).toMatch(/Chicha/);
    expect(String(result?.content)).not.toMatch(/sobre cuál/i);
  });
});
