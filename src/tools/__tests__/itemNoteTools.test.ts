import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn() },
    draft_order_item: { update: vi.fn() },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
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

const PRODUCT_A = '11111111-1111-1111-1111-111111111111';
const LINE_1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const LINE_2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

describe('item note tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('start_item_note con 2 ítems setea pending sin productId', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      draft_order_item: [
        {
          product_id: PRODUCT_A,
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

  it('start_item_note guarda candidateLineIds al desambiguar', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      draft_order_item: [
        {
          id: LINE_1,
          product_id: PRODUCT_A,
          menu_item: { name: 'Chicha' },
        },
        {
          id: LINE_2,
          product_id: PRODUCT_A,
          menu_item: { name: 'Chicha' },
        },
      ],
    } as never);
    vi.mocked(setPendingItemNote).mockResolvedValue({
      askedAt: new Date().toISOString(),
      productId: PRODUCT_A,
      productName: 'Chicha',
      noteText: 'sin azúcar',
      candidateLineIds: [LINE_1, LINE_2],
      source: 'hybrid',
    });

    const raw = await startItemNoteTool.func(
      {
        productId: PRODUCT_A,
        noteText: 'sin azúcar',
        candidateLineIds: [LINE_1, LINE_2],
      },
      undefined,
      CONFIG
    );
    expect(JSON.parse(raw as string).success).toBe(true);
    expect(setPendingItemNote).toHaveBeenCalledWith(
      expect.objectContaining({
        noteText: 'sin azúcar',
        candidateLineIds: [LINE_1, LINE_2],
      })
    );
  });

  it('clear_pending_item_note limpia metadata', async () => {
    const raw = await clearPendingItemNoteTool.func({}, undefined, CONFIG);
    expect(JSON.parse(raw as string)).toEqual({ cleared: true });
    expect(clearPendingItemNote).toHaveBeenCalledWith('conv-1');
  });

  it('update_item_note exitoso limpia pendingItemNote', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      draft_order_item: [
        {
          id: LINE_1,
          product_id: PRODUCT_A,
          variation: null,
          quantity: 1,
          menu_item: { id: PRODUCT_A, name: 'Chupe' },
        },
      ],
    } as never);
    vi.mocked(prisma.draft_order_item.update).mockResolvedValue({} as never);

    const raw = await updateItemNoteTool.func(
      { productId: PRODUCT_A, note: 'sin picante' },
      undefined,
      CONFIG
    );
    const parsed = JSON.parse(raw as string);
    expect(parsed.success).toBe(true);
    expect(parsed.updatedCount).toBe(1);
    expect(clearPendingItemNote).toHaveBeenCalledWith('conv-1');
  });

  it('update_item_note con ≥2 líneas del mismo productId → ambiguous_lines', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      draft_order_item: [
        {
          id: LINE_1,
          product_id: PRODUCT_A,
          variation: 'Especial',
          quantity: 1,
          menu_item: { id: PRODUCT_A, name: 'Chicha' },
        },
        {
          id: LINE_2,
          product_id: PRODUCT_A,
          variation: 'Roquefort',
          quantity: 1,
          menu_item: { id: PRODUCT_A, name: 'Chicha' },
        },
      ],
    } as never);

    const raw = await updateItemNoteTool.func(
      { productId: PRODUCT_A, note: 'sin azúcar' },
      undefined,
      CONFIG
    );
    const parsed = JSON.parse(raw as string);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe('ambiguous_lines');
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0].draftOrderItemId).toBe(LINE_1);
    expect(clearPendingItemNote).not.toHaveBeenCalled();
    expect(prisma.draft_order_item.update).not.toHaveBeenCalled();
  });

  it('update_item_note con draftOrderItemIds aplica a todas las líneas', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      draft_order_item: [
        {
          id: LINE_1,
          product_id: PRODUCT_A,
          variation: 'Especial',
          quantity: 1,
          menu_item: { id: PRODUCT_A, name: 'Chicha' },
        },
        {
          id: LINE_2,
          product_id: PRODUCT_A,
          variation: 'Roquefort',
          quantity: 1,
          menu_item: { id: PRODUCT_A, name: 'Chicha' },
        },
      ],
    } as never);
    vi.mocked(prisma.draft_order_item.update).mockResolvedValue({} as never);

    const raw = await updateItemNoteTool.func(
      {
        draftOrderItemIds: [LINE_1, LINE_2],
        note: 'sin azúcar',
      },
      undefined,
      CONFIG
    );
    const parsed = JSON.parse(raw as string);
    expect(parsed.success).toBe(true);
    expect(parsed.updatedCount).toBe(2);
    expect(prisma.draft_order_item.update).toHaveBeenCalledTimes(2);
    expect(clearPendingItemNote).toHaveBeenCalledWith('conv-1');
  });

  it('update_item_note con draftOrderItemId apunta a una sola línea', async () => {
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      draft_order_item: [
        {
          id: LINE_1,
          product_id: PRODUCT_A,
          variation: 'Especial',
          quantity: 1,
          menu_item: { id: PRODUCT_A, name: 'Chicha' },
        },
        {
          id: LINE_2,
          product_id: PRODUCT_A,
          variation: 'Roquefort',
          quantity: 1,
          menu_item: { id: PRODUCT_A, name: 'Chicha' },
        },
      ],
    } as never);
    vi.mocked(prisma.draft_order_item.update).mockResolvedValue({} as never);

    const raw = await updateItemNoteTool.func(
      { draftOrderItemId: LINE_2, note: 'poca sal' },
      undefined,
      CONFIG
    );
    const parsed = JSON.parse(raw as string);
    expect(parsed.success).toBe(true);
    expect(parsed.updatedCount).toBe(1);
    expect(parsed.items[0].draftOrderItemId).toBe(LINE_2);
    expect(prisma.draft_order_item.update).toHaveBeenCalledWith({
      where: { id: LINE_2 },
      data: { notes: 'poca sal' },
    });
  });
});
