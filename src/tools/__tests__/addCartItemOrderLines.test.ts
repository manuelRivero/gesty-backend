/**
 * `add_cart_item` con cola de pedido activa (PLAN-ACCION-PEDIDO-MULTI-LINEA.md).
 *
 * La cantidad de línea (`plan_order_lines`) cuenta como unidades dichas (no ask
 * de quantity). El Fact de personas es obligatorio antes del add: la cantidad
 * de línea no saltea party size.
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
    $queryRaw: vi.fn(async () => [
      {
        bot_enabled: true,
        orders_enabled: true,
        reservations_enabled: true,
      },
    ]),
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

const setPendingAddQuantity = vi.fn().mockResolvedValue({
  productId: 'p',
  productName: 'Papa a la huancaina',
  suggestedQuantity: 4,
  servesPeople: 1,
  partySize: 4,
  source: 'hybrid',
  askedAt: new Date().toISOString(),
});

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

const advanceAfterLineClose = vi.fn().mockResolvedValue(null);

vi.mock('../../services/pendingOrderLines.service', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../services/pendingOrderLines.service')>();
  return {
    ...actual,
    advanceAfterLineClose: (...args: unknown[]) => advanceAfterLineClose(...args),
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

const menuItem = (name: string) => ({
  id: PRODUCT_ID,
  name,
  serves_people: 1,
  discount_type: null,
  discount_value: null,
  variations: [],
  menu_item_price: [{ amount: new Prisma.Decimal(1000), currency_code: 'ARS' }],
});

/** Cola "1 ceviche, 2 papas a la huancaína y una chicha". */
const metadataWithQueue = (over?: {
  requestedQuantity?: number | null;
  partySize?: number | null;
}) => ({
  ...(over?.partySize != null
    ? { peopleCount: over.partySize, requestedPartySize: over.partySize }
    : {}),
  pendingOrderLines: {
    lines: [
      {
        id: 'line-papas',
        hint: 'papas a la huancaína',
        requestedQuantity:
          over && 'requestedQuantity' in over ? over.requestedQuantity! : 2,
        status: 'active' as const,
      },
      { id: 'line-chicha', hint: 'una chicha morada', requestedQuantity: 1, status: 'queued' as const },
    ],
    sourceMessage: '1 ceviche, 2 papas a la huancaína y una chicha',
    createdAt: new Date().toISOString(),
  },
});

const metaWithPartyAndQueue = () => metadataWithQueue({ partySize: 4 });

const callTool = (input: { productId: string; quantity?: number }) =>
  addCartItemTool.func(input, undefined, CONFIG);

describe('add_cart_item — cola de pedido y cantidad por línea', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: new Prisma.Decimal(2000) },
    } as never);
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.draft_order_item.findFirst).mockResolvedValue(null as never);
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(
      menuItem('Papa a la huancaina') as never
    );
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: metaWithPartyAndQueue(),
    } as never);
    findOrCreateConversationState.mockResolvedValue({ metadata: metaWithPartyAndQueue() });
    advanceAfterLineClose.mockResolvedValue(null);
  });

  it('línea con cantidad: escribe esa cantidad sin ask de unidades (con Fact de personas)', async () => {
    const result = JSON.parse((await callTool({ productId: PRODUCT_ID })) as string);

    expect(result.success).toBe(true);
    expect(result.added.quantity).toBe(2);
    expect(setPendingAddQuantity).not.toHaveBeenCalled();
    expect(prisma.draft_order_item.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ quantity: 2 }) })
    );
  });

  it('línea con cantidad: igual exige party size si falta el Fact de personas', async () => {
    const noParty = metadataWithQueue();
    findOrCreateConversationState.mockResolvedValue({ metadata: noParty });
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: noParty,
    } as never);

    const result = JSON.parse((await callTool({ productId: PRODUCT_ID })) as string);
    expect(result).toEqual(
      expect.objectContaining({ success: false, error: 'party_size_required' })
    );
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
  });

  it('quantity del turno gana a la de la línea (corrección "mejor 3 papas")', async () => {
    const result = JSON.parse(
      (await callTool({ productId: PRODUCT_ID, quantity: 3 })) as string
    );

    expect(result.added.quantity).toBe(3);
    expect(setPendingAddQuantity).not.toHaveBeenCalled();
  });

  it('línea SIN cantidad: sigue bloqueando por personas (Goal blocking)', async () => {
    const noQty = metadataWithQueue({ requestedQuantity: null });
    findOrCreateConversationState.mockResolvedValue({ metadata: noQty });
    vi.mocked(prisma.conversation_state.findUnique).mockResolvedValue({
      metadata: noQty,
    } as never);

    const result = JSON.parse((await callTool({ productId: PRODUCT_ID })) as string);

    expect(result).toEqual(
      expect.objectContaining({ success: false, error: 'party_size_required' })
    );
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
  });

  it('producto ajeno a la cola: no toma la cantidad de otra línea', async () => {
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(
      menuItem('Lomo saltado') as never
    );

    const result = JSON.parse((await callTool({ productId: PRODUCT_ID })) as string);

    // Sin match de línea: con Fact de personas suma qty 1 (ask path) o pending quantity.
    // Acá el fixture tiene party size → no party_size_required.
    expect(result.error).not.toBe('party_size_required');
  });

  it('cierra la línea que matchea el producto, no siempre la activa', async () => {
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(
      menuItem('Chicha morada') as never
    );

    await callTool({ productId: PRODUCT_ID });

    expect(advanceAfterLineClose).toHaveBeenCalledWith(
      expect.objectContaining({ lineId: 'line-chicha', closeStatus: 'done' })
    );
  });
});
