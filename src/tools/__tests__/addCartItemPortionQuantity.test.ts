/**
 * Unidades vs cobertura en add_cart_item.
 * Un quantity numérico del modelo no es "2 unidades" si el mensaje habla de personas.
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
  getPendingVariation: vi.fn().mockReturnValue(null),
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

const setPendingAddQuantity = vi.fn();

vi.mock('../../services/pendingAddQuantity.service', () => ({
  setPendingAddQuantity: (...args: unknown[]) => setPendingAddQuantity(...args),
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

const withMessage = (userMessage: string) => ({
  configurable: { ...CONFIG.configurable, userMessage },
});

const partyMeta = (partySize: number) => ({
  peopleCount: partySize,
  requestedPartySize: partySize,
});

describe('add_cart_item — unidades vs cobertura', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPendingAddQuantity.mockImplementation(async (args: { suggestedQuantity: number }) => ({
      productId: PRODUCT_ID,
      productName: 'Ceviche Clásico',
      suggestedQuantity: args.suggestedQuantity,
      servesPeople: 2,
      partySize: 3,
      source: 'hybrid',
      askedAt: new Date().toISOString(),
    }));
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);
    vi.mocked(prisma.draft_order_item.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.draft_order_item.create).mockResolvedValue({ id: 'item-1' } as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: new Prisma.Decimal(100) },
    } as never);
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: {},
    } as never);
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

  const add = (userMessage: string, quantity?: number) =>
    addCartItemTool.func(
      { productId: PRODUCT_ID, ...(quantity != null ? { quantity } : {}) },
      undefined,
      withMessage(userMessage)
    );

  const writtenQty = () => {
    const call = vi.mocked(prisma.draft_order_item.create).mock.calls[0]?.[0] as
      | { data: { quantity: number } }
      | undefined;
    return call?.data.quantity;
  };

  it('cobertura: "para dos personas" escribe 1 aunque el modelo mande 2', async () => {
    findOrCreateConversationState.mockResolvedValue({ metadata: partyMeta(2) });

    const result = JSON.parse(
      (await add('Quiero ceviche para dos personas', 2)) as string
    );

    expect(result.success).toBe(true);
    expect(result.added.quantity).toBe(1);
    expect(writtenQty()).toBe(1);
    expect(setPendingAddQuantity).not.toHaveBeenCalled();
  });

  it('cobertura implícita: "somos dos" escribe 1 aunque el modelo mande 2', async () => {
    findOrCreateConversationState.mockResolvedValue({ metadata: partyMeta(2) });

    const result = JSON.parse(
      (await add('Somos dos y queremos ceviche', 2)) as string
    );

    expect(result.success).toBe(true);
    expect(result.added.quantity).toBe(1);
    expect(writtenQty()).toBe(1);
  });

  it('unidades explícitas: "dos ceviches" escribe 2', async () => {
    findOrCreateConversationState.mockResolvedValue({ metadata: partyMeta(2) });

    const result = JSON.parse((await add('Quiero dos ceviches', 2)) as string);

    expect(result.success).toBe(true);
    expect(result.added.quantity).toBe(2);
    expect(writtenQty()).toBe(2);
  });

  it('unidades explícitas: "Quiero 3 papas" conserva quantity 3', async () => {
    findOrCreateConversationState.mockResolvedValue({ metadata: partyMeta(3) });

    const result = JSON.parse((await add('Quiero 3 papas', 3)) as string);

    expect(result.success).toBe(true);
    expect(result.added.quantity).toBe(3);
    expect(writtenQty()).toBe(3);
  });

  it('unidades explícitas ganan a la cobertura: "dos ceviches para dos personas"', async () => {
    findOrCreateConversationState.mockResolvedValue({ metadata: partyMeta(2) });

    const result = JSON.parse(
      (await add('Quiero dos ceviches para dos personas', 2)) as string
    );

    expect(result.success).toBe(true);
    expect(result.added.quantity).toBe(2);
    expect(writtenQty()).toBe(2);
  });

  it('una unidad explícita con personas: "un ceviche para dos" escribe 1', async () => {
    findOrCreateConversationState.mockResolvedValue({ metadata: partyMeta(2) });

    const result = JSON.parse((await add('Quiero un ceviche para dos', 1)) as string);

    expect(result.success).toBe(true);
    expect(result.added.quantity).toBe(1);
    expect(writtenQty()).toBe(1);
  });

  it('sin unidades dichas y cobertura 2 sigue preguntando (ceil(3/2))', async () => {
    findOrCreateConversationState.mockResolvedValue({ metadata: partyMeta(3) });

    const omitted = JSON.parse((await add('Quiero ceviche')) as string);

    expect(omitted.success).toBe(false);
    expect(omitted.error).toBe('quantity_required');
    expect(omitted.suggestedQuantity).toBe(2);
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    expect(setPendingAddQuantity).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedQuantity: 2, partySize: 3 })
    );

    const copiedParty = JSON.parse((await add('Quiero ceviche', 3)) as string);

    expect(copiedParty.success).toBe(false);
    expect(copiedParty.error).toBe('quantity_required');
    expect(copiedParty.suggestedQuantity).toBe(2);
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
  });
});
