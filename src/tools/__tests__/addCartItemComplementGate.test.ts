/**
 * Soft-gate: ola de complemento viva → add solo si el mensaje nombra un candidato.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../lib/prisma', () => ({
  prisma: {
    draft_order: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    menu_item: { findFirst: vi.fn(), findMany: vi.fn() },
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
  setPendingAddQuantity: vi.fn().mockResolvedValue({
    suggestedQuantity: 2,
    productId: '11111111-1111-1111-1111-111111111111',
    productName: 'Chicha Morada',
  }),
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
    userMessage: 'Estoy bien así',
  },
};

const CHICHA_ID = '11111111-1111-1111-1111-111111111111';
const PISCO_ID = '22222222-2222-2222-2222-222222222222';

describe('add_cart_item — complement selection soft-gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue({
      id: CHICHA_ID,
      name: 'Chicha Morada',
      serves_people: 1,
      discount_type: null,
      discount_value: null,
      variations: [],
      menu_item_price: [{ amount: new Prisma.Decimal(50), currency_code: 'ARS' }],
    } as never);
    vi.mocked(prisma.menu_item.findMany).mockResolvedValue([
      { id: CHICHA_ID, name: 'Chicha Morada' },
      { id: PISCO_ID, name: 'Pisco Sour' },
    ] as never);
  });

  it('bloquea add si ola de complemento y el mensaje no nombra candidato', async () => {
    const meta = {
      peopleCount: 2,
      requestedPartySize: 2,
      pendingProductSelection: true,
      pendingComplementSelection: true,
      candidateProductIds: [CHICHA_ID, PISCO_ID],
    };
    findOrCreateConversationState.mockResolvedValue({ metadata: meta });
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: meta,
    } as never);

    const result = JSON.parse(
      (await addCartItemTool.func({ productId: CHICHA_ID }, undefined, CONFIG)) as string
    );

    expect(result).toEqual(
      expect.objectContaining({
        success: false,
        error: 'complement_selection_required',
      })
    );
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
  });

  it('no bloquea con complement_selection_required si el mensaje nombra un candidato', async () => {
    const meta = {
      peopleCount: 1,
      requestedPartySize: 1,
      pendingProductSelection: true,
      pendingComplementSelection: true,
      candidateProductIds: [CHICHA_ID, PISCO_ID],
    };
    findOrCreateConversationState.mockResolvedValue({ metadata: meta });
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: meta,
    } as never);
    vi.mocked(prisma.draft_order_item.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([
      {
        id: 'item-1',
        product_id: CHICHA_ID,
        quantity: 1,
        unit_price: new Prisma.Decimal(50),
        total_price: new Prisma.Decimal(50),
        list_price: null,
        discount_amount: null,
        variation: null,
        menu_item: { name: 'Chicha Morada' },
      },
    ] as never);
    vi.mocked(prisma.draft_order_item.create).mockResolvedValue({
      id: 'item-1',
      quantity: 1,
      unit_price: new Prisma.Decimal(50),
      total_price: new Prisma.Decimal(50),
    } as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: new Prisma.Decimal(50) },
    } as never);
    (prisma as unknown as { promotion: { findMany: ReturnType<typeof vi.fn> } }).promotion = {
      findMany: vi.fn().mockResolvedValue([]),
    };

    const result = JSON.parse(
      (await addCartItemTool.func(
        { productId: CHICHA_ID, quantity: 1 },
        undefined,
        {
          configurable: {
            ...CONFIG.configurable,
            userMessage: 'dame una chicha morada',
          },
        }
      )) as string
    );

    expect(result.error).not.toBe('complement_selection_required');
    expect(prisma.menu_item.findMany).toHaveBeenCalled();
    expect(prisma.draft_order_item.create).toHaveBeenCalled();
  });

  it('no aplica soft-gate si no es ola de complemento (shortlist de búsqueda)', async () => {
    const meta = {
      peopleCount: 2,
      requestedPartySize: 2,
      pendingProductSelection: true,
      candidateProductIds: [CHICHA_ID, PISCO_ID],
    };
    findOrCreateConversationState.mockResolvedValue({ metadata: meta });
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: meta,
    } as never);

    const result = JSON.parse(
      (await addCartItemTool.func(
        { productId: CHICHA_ID, quantity: 1 },
        undefined,
        {
          configurable: {
            ...CONFIG.configurable,
            userMessage: 'el de 100 pesos',
          },
        }
      )) as string
    );

    expect(result.error).not.toBe('complement_selection_required');
    expect(prisma.menu_item.findMany).not.toHaveBeenCalled();
  });
});
