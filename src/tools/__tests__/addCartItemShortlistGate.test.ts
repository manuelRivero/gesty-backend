/**
 * Un shortlist de ≥2 ya no bloquea add_cart_item: si el modelo conoce el plato, lo suma.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    menu_item: { findFirst: vi.fn() },
    draft_order_item: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      aggregate: vi.fn(),
      findMany: vi.fn(),
    },
    business: { findUnique: vi.fn() },
    conversation_state: { findUnique: vi.fn() },
    $queryRaw: vi.fn(async () => [{ bot_enabled: true, orders_enabled: true }]),
  },
}));

vi.mock('../../services/ordersCapabilityGate.service', () => ({
  assertCanOrder: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../services/menu.service', () => ({ MenuService: {} }));
vi.mock('../../services/draftOrderTimeout.service', () => ({
  refreshDraftOrderTimeout: vi.fn(),
}));
vi.mock('../../services/lastOffer.service', () => ({ clearLastOffer: vi.fn() }));
vi.mock('../../services/pendingVariation.service', () => ({
  setPendingVariation: vi.fn(),
  clearPendingVariation: vi.fn(),
}));
vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn(),
  omitConversationMetadataKeys: vi.fn(),
}));

const findOrCreateConversationState = vi.fn();

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: (...args: unknown[]) =>
      findOrCreateConversationState(...args),
    patchConversationMetadata: vi.fn(),
    omitConversationMetadataKeys: vi.fn(),
  };
});

vi.mock('../../services/pendingAddQuantity.service', () => ({
  setPendingAddQuantity: vi.fn(),
  clearPendingAddQuantity: vi.fn(),
  getPendingAddQuantity: vi.fn().mockReturnValue(null),
  isPendingAddQuantityReply: vi.fn().mockReturnValue(false),
  buildPendingAddQuantityMessage: vi.fn().mockReturnValue('¿Cuántas?'),
}));

vi.mock('../../services/orderCompletionGoal.service', () => ({
  getOrderCompletionLedger: vi.fn(),
  recordOrderCompletionAbandonment: vi.fn(),
  reviveOrderCompletionIfAbandoned: vi.fn(),
}));

vi.mock('../../services/intent/opportunities.service', () => ({
  markComplementEngagedIfOffered: vi.fn(),
  markComplementRefused: vi.fn(),
  resolvePostAddComplementOpportunity: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../services/pendingOrderLines.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/pendingOrderLines.service')>();
  return {
    ...actual,
    advanceAfterLineClose: vi.fn().mockResolvedValue(null),
  };
});

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

const PRODUCT_ID = '11111111-1111-1111-1111-111111111111';

describe('add_cart_item — shortlistAwaitingChoice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue({
      id: PRODUCT_ID,
      name: 'Ceviche Clásico',
      serves_people: 2,
      discount_type: null,
      discount_value: null,
      variations: [],
      menu_item_price: [{ amount: new Prisma.Decimal(100), currency_code: 'ARS' }],
    } as never);
  });

  it('suma el plato aunque shortlistAwaitingChoice esté activo', async () => {
    const meta = {
      peopleCount: 2,
      requestedPartySize: 2,
      shortlistAwaitingChoice: true,
      pendingProductSelection: true,
      candidateProductIds: [PRODUCT_ID, '22222222-2222-2222-2222-222222222222'],
    };
    findOrCreateConversationState.mockResolvedValue({ metadata: meta });
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: meta,
    } as never);
    vi.mocked(prisma.draft_order_item.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.draft_order_item.create).mockResolvedValue({
      id: 'item-1',
      quantity: 1,
    } as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: new Prisma.Decimal(100) },
    } as never);
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([] as never);

    const result = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, quantity: 1 },
        undefined,
        CONFIG
      )) as string
    );

    expect(result.error).not.toBe('shortlist_selection_required');
    expect(result.success).toBe(true);
    expect(prisma.draft_order_item.create).toHaveBeenCalled();
  });
});
