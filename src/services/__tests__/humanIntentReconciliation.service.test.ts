import { beforeEach, describe, expect, it, vi } from 'vitest';

const { conversationStateFindUnique, draftOrderFindFirst, reconcileActiveMock } = vi.hoisted(() => ({
  conversationStateFindUnique: vi.fn(),
  draftOrderFindFirst: vi.fn(),
  reconcileActiveMock: vi.fn(),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    conversation_state: { findUnique: conversationStateFindUnique },
    draft_order: { findFirst: draftOrderFindFirst },
  },
}));

vi.mock('../humanIntentState.service', () => ({
  reconcileActiveHumanIntent: reconcileActiveMock,
}));

import { reconcileHumanIntentAfterToolEffect } from '../humanIntentReconciliation.service';

const ACTIVE = {
  id: 'intent-order',
  sequence: 1,
  goal: 'PEDIR',
  request: { products: ['A', 'B'] },
  status: 'ACTIVE',
  blockers: [],
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};

const effect = {
  kind: 'add_cart_item',
  reference: 'product-b',
  occurredAt: '2026-09-28T00:00:00.000Z',
  success: true as const,
};

describe('reconcileHumanIntentAfterToolEffect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    conversationStateFindUnique.mockResolvedValue({ metadata: {} });
    draftOrderFindFirst.mockResolvedValue({
      draft_order_item: [
        { product_id: 'product-a' },
        { product_id: 'product-b' },
      ],
    });
    reconcileActiveMock.mockImplementation(
      async (_conversationId, _effect, isSatisfied) =>
        isSatisfied(ACTIVE) ? { ...ACTIVE, status: 'RESOLVED' } : null
    );
  });

  it('no resuelve tras agregar A cuando B sigue en el plan, aunque el carrito tenga A', async () => {
    conversationStateFindUnique.mockResolvedValue({
      metadata: {
        pendingOrderLines: {
          lines: [{ id: 'line-b', hint: 'B', requestedQuantity: 1, status: 'queued' }],
        },
      },
    });
    draftOrderFindFirst.mockResolvedValue({
      draft_order_item: [{ product_id: 'product-a' }],
    });

    const resolved = await reconcileHumanIntentAfterToolEffect({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      customerPhone: '+5491100000000',
      effect: { ...effect, reference: 'product-a' },
    });

    expect(resolved).toBeNull();
    expect(reconcileActiveMock.mock.calls[0][2](ACTIVE)).toBe(false);
  });

  it('resuelve cuando el efecto está en el carrito persistido y no queda plan abierto', async () => {
    const resolved = await reconcileHumanIntentAfterToolEffect({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      customerPhone: '+5491100000000',
      effect,
    });

    expect(resolved).toMatchObject({ status: 'RESOLVED' });
    expect(reconcileActiveMock.mock.calls[0][2](ACTIVE)).toBe(true);
  });

  it('sin referencia de carrito, un efecto persistido no completa PEDIR', async () => {
    const resolved = await reconcileHumanIntentAfterToolEffect({
      conversationId: 'conv-1',
      businessId: 'biz-1',
      customerPhone: '+5491100000000',
      effect: { ...effect, reference: undefined },
    });

    expect(resolved).toBeNull();
    expect(reconcileActiveMock).toHaveBeenCalledOnce();
    expect(reconcileActiveMock.mock.calls[0][2](ACTIVE)).toBe(false);
  });
});