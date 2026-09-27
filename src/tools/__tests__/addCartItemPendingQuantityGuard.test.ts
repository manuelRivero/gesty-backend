/**
 * pendingAddQuantity es exclusivo: solo ese productId puede escribirse.
 * Un alta del otro producto no toca el carrito, y sigue bloqueado en el mismo
 * turno aunque el alta correcta ya haya limpiado el pending.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { userMessageStatesUnitQuantity } from '../../services/addQuantitySuggestion';

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
    conversation_state: { findUnique: vi.fn(), update: vi.fn() },
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

const omitConversationMetadataKeys = vi.fn();

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: (...args: unknown[]) =>
      findOrCreateConversationState(...args),
    patchConversationMetadata: vi.fn(),
    omitConversationMetadataKeys: (...args: unknown[]) =>
      omitConversationMetadataKeys(...args),
  };
});

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

vi.mock('../../services/intent/promotionOpportunity.service', () => ({
  resolvePostAddPromotion: vi.fn().mockResolvedValue(null),
}));

const JUGO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CEVICHE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let pending: {
  productId: string;
  productName: string;
  suggestedQuantity: number;
  servesPeople: number;
  partySize: number;
  source: 'hybrid';
  askedAt: string;
} | null = null;

const findOrCreateConversationState = vi.fn();

import { addCartItemTool } from '../index';
import { prisma } from '../../lib/prisma';
import { getPendingAddQuantity } from '../../services/pendingAddQuantity.service';

const menuItem = (id: string, name: string, serves: number) => ({
  id,
  name,
  serves_people: serves,
  discount_type: null,
  discount_value: null,
  variations: [],
  menu_item_price: [{ amount: new Prisma.Decimal(100), currency_code: 'ARS' }],
});

const configFor = (userMessage: string, turnStartedAt: string) => ({
  configurable: {
    businessId: 'biz-1',
    customerId: 'cust-1',
    customerPhone: '+5491100000000',
    conversationId: 'conv-qty-guard',
    conversationStartedAt: '2026-09-27T12:00:00.000Z',
    turnStartedAt,
    userMessage,
  },
});

const add = (
  productId: string,
  quantity: number,
  userMessage: string,
  turnStartedAt: string
) =>
  addCartItemTool.func(
    { productId, quantity },
    undefined,
    configFor(userMessage, turnStartedAt)
  );

const createdLines = () =>
  vi.mocked(prisma.draft_order_item.create).mock.calls.map((call) => {
    const data = (call[0] as { data: { product_id: string; quantity: number } }).data;
    return { productId: data.product_id, quantity: data.quantity };
  });

describe('add_cart_item — pendingAddQuantity exclusivo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pending = {
      productId: JUGO,
      productName: 'Jugo de pina',
      suggestedQuantity: 2,
      servesPeople: 1,
      partySize: 2,
      source: 'hybrid',
      askedAt: '2020-01-01T00:00:00.000Z',
    };
    findOrCreateConversationState.mockImplementation(async () => ({
      metadata: {
        peopleCount: 2,
        requestedPartySize: 2,
        ...(pending ? { pendingAddQuantity: pending } : {}),
      },
    }));
    omitConversationMetadataKeys.mockImplementation(async (_id: string, keys: string[]) => {
      if (keys.includes('pendingAddQuantity')) pending = null;
    });
    vi.mocked(prisma.conversation_state.findUnique).mockImplementation((async () => ({
      metadata: {
        peopleCount: 2,
        requestedPartySize: 2,
        ...(pending ? { pendingAddQuantity: pending } : {}),
      },
    })) as never);
    vi.mocked(prisma.conversation_state.update).mockImplementation((async (args: {
      data?: { metadata?: Record<string, unknown> };
    }) => {
      const meta = args.data?.metadata;
      if (meta && !Object.prototype.hasOwnProperty.call(meta, 'pendingAddQuantity')) {
        pending = null;
      }
      return { metadata: meta };
    }) as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({ id: 'draft-1' } as never);
    vi.mocked(prisma.draft_order_item.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.draft_order_item.create).mockResolvedValue({ id: 'item-1' } as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: new Prisma.Decimal(100) },
    } as never);
    vi.mocked(prisma.draft_order_item.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.menu_item.findFirst).mockImplementation((async (args: {
      where?: { id?: string };
    } | undefined) => {
      const id = args?.where?.id;
      if (id === JUGO) return menuItem(JUGO, 'Jugo de pina', 1);
      if (id === CEVICHE) return menuItem(CEVICHE, 'Ceviche Clásico', 2);
      return null;
    }) as never);
  });

  it('el producto pendiente se agrega y el pending se limpia', async () => {
    const turn = '2026-09-27T15:00:01.000Z';
    const result = JSON.parse((await add(JUGO, 2, 'bueno dame 2', turn)) as string);

    expect(result.success).toBe(true);
    expect(result.added.productId).toBe(JUGO);
    expect(result.added.quantity).toBe(2);
    expect(createdLines()).toEqual([{ productId: JUGO, quantity: 2 }]);
    expect(pending).toBeNull();
    expect(getPendingAddQuantity({ peopleCount: 2 })).toBeNull();
  });

  it('otro producto se rechaza sin escribir ni limpiar el pending', async () => {
    const turn = '2026-09-27T15:00:02.000Z';
    const result = JSON.parse((await add(CEVICHE, 1, 'bueno dame 2', turn)) as string);

    expect(result.success).toBe(false);
    expect(result.error).toBe('pending_quantity_other_product');
    expect(result.pendingProductId).toBe(JUGO);
    expect(result.pendingProductName).toBe('Jugo de pina');
    expect(createdLines()).toEqual([]);
    expect(pending?.productId).toBe(JUGO);
    expect(omitConversationMetadataKeys).not.toHaveBeenCalled();
  });

  it('en el mismo turno el ceviche no entra ni antes ni después del clear', async () => {
    const turn = '2026-09-27T15:00:03.000Z';
    const [jugoRaw, cevicheRaw] = await Promise.all([
      add(JUGO, 2, 'bueno dame 2', turn),
      add(CEVICHE, 1, 'bueno dame 2', turn),
    ]);
    const jugo = JSON.parse(jugoRaw as string);
    const ceviche = JSON.parse(cevicheRaw as string);

    expect(jugo.success).toBe(true);
    expect(jugo.added.quantity).toBe(2);
    expect(ceviche.success).toBe(false);
    expect(ceviche.error).toBe('pending_quantity_other_product');
    expect(createdLines()).toEqual([{ productId: JUGO, quantity: 2 }]);
    expect(pending).toBeNull();

    const afterClear = JSON.parse((await add(CEVICHE, 1, 'bueno dame 2', turn)) as string);
    expect(afterClear.success).toBe(false);
    expect(afterClear.error).toBe('pending_quantity_other_product');
    expect(createdLines()).toEqual([{ productId: JUGO, quantity: 2 }]);
  });

  it.each(['2', 'dame 2', 'bueno dame 2', 'quiero 2', 'dos'])(
    '"%s" agrega solo el jugo',
    async (message) => {
      const turn = `2026-09-27T15:01:${message.length.toString().padStart(2, '0')}.000Z`;
      pending = {
        productId: JUGO,
        productName: 'Jugo de pina',
        suggestedQuantity: 2,
        servesPeople: 1,
        partySize: 2,
        source: 'hybrid',
        askedAt: '2020-01-01T00:00:00.000Z',
      };
      const jugo = JSON.parse((await add(JUGO, 2, message, turn)) as string);
      const ceviche = JSON.parse((await add(CEVICHE, 1, message, turn)) as string);

      expect(jugo.success).toBe(true);
      expect(jugo.added.productId).toBe(JUGO);
      expect(jugo.added.quantity).toBe(2);
      expect(ceviche.success).toBe(false);
      expect(ceviche.error).toBe('pending_quantity_other_product');
      expect(createdLines().every((line) => line.productId === JUGO && line.quantity === 2)).toBe(
        true
      );
      expect(createdLines().some((line) => line.productId === CEVICHE)).toBe(false);
    }
  );

  it('"para dos" no es unidades y no habilita el otro producto', async () => {
    expect(userMessageStatesUnitQuantity('para dos', 2)).toBe(false);

    pending = null;
    const coverage = JSON.parse(
      (await add(CEVICHE, 2, 'para dos', '2026-09-27T15:02:01.000Z')) as string
    );
    expect(coverage.success).toBe(true);
    expect(coverage.added.quantity).toBe(1);

    pending = {
      productId: JUGO,
      productName: 'Jugo de pina',
      suggestedQuantity: 2,
      servesPeople: 1,
      partySize: 2,
      source: 'hybrid',
      askedAt: '2020-01-01T00:00:00.000Z',
    };
    vi.mocked(prisma.draft_order_item.create).mockClear();
    const turn = '2026-09-27T15:02:02.000Z';
    const blocked = JSON.parse((await add(CEVICHE, 1, 'para dos', turn)) as string);
    expect(blocked.error).toBe('pending_quantity_other_product');
    expect(createdLines()).toEqual([]);
    expect(pending?.productId).toBe(JUGO);
  });

  it('el alta rechazada no es el producto del cierre', async () => {
    const turn = '2026-09-27T15:03:01.000Z';
    const jugo = JSON.parse((await add(JUGO, 2, 'bueno dame 2', turn)) as string);
    const ceviche = JSON.parse((await add(CEVICHE, 1, 'bueno dame 2', turn)) as string);

    expect(jugo.success).toBe(true);
    expect(jugo.added.productId).toBe(JUGO);
    expect(jugo.added.itemName).toBe('Jugo de pina');
    expect(ceviche.success).toBe(false);
    expect(ceviche.added).toBeUndefined();
  });
});
