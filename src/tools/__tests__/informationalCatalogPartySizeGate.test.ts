/**
 * Gesty ya no exige OBTENER_PERSONAS_DEL_PEDIDO (cantidad de personas) para
 * consultar catálogo ni para operaciones transaccionales de pedido
 * (add_cart_item, plan_order_lines, present_category, present_product_cta,
 * search_products, find_products_by_filter): ninguna de estas tools bloquea
 * sin ese dato, sin importar el HumanIntent activo.
 *
 * `get_complementary_suggestions` queda explícitamente FUERA de este cambio
 * (investigación de "sugerencias de complemento" por separado) y conserva
 * el gate incondicional anterior.
 *
 * Ver docs/arquitectura (auditoría "eliminar party size como requisito
 * general del pedido") para el diagnóstico completo.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const findOrCreateConversationState = vi.fn();
const patchConversationMetadata = vi.fn();
const omitConversationMetadataKeys = vi.fn();

vi.mock('../../lib/prisma', () => {
  const prisma: any = {
    business: { findUnique: vi.fn().mockResolvedValue({ currency_code: 'ARS' }) },
    menu_item: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
    draft_order: {
      findFirst: vi.fn().mockResolvedValue({ id: 'draft-1' }),
      create: vi.fn(async () => ({ id: 'draft-1' })),
      update: vi.fn(),
    },
    draft_order_item: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async () => ({ id: 'created-line-id' })),
      update: vi.fn(),
      aggregate: vi.fn().mockResolvedValue({ _sum: { total_price: 1000 } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    conversation_state: { findUnique: vi.fn().mockResolvedValue({ metadata: {} }) },
    $queryRaw: vi.fn(async () => [
      { bot_enabled: true, orders_enabled: true, reservations_enabled: true },
    ]),
  };
  prisma.$executeRaw = vi.fn();
  prisma.$transaction = vi.fn(async (callback: (tx: any) => unknown) => callback(prisma));
  return { prisma };
});

vi.mock('../../services/menu.service', () => ({
  MenuService: {
    searchMenuItemsByKeyword: vi.fn().mockResolvedValue([
      { id: 'prod-1', name: 'Ceviche Clásico', category_id: null, category_name: null, category_tag: null },
    ]),
  },
}));

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: (...args: unknown[]) =>
      findOrCreateConversationState(...args),
    patchConversationMetadata: (...args: unknown[]) => patchConversationMetadata(...args),
    omitConversationMetadataKeys: (...args: unknown[]) =>
      omitConversationMetadataKeys(...args),
  };
});

vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: (...args: unknown[]) => patchConversationMetadata(...args),
  omitConversationMetadataKeys: (...args: unknown[]) => omitConversationMetadataKeys(...args),
}));

vi.mock('../../services/ordersCapabilityGate.service', () => ({
  assertCanOrder: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock('../../services/productResolution.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/productResolution.service')>();
  return {
    ...actual,
    issueProductResolutions: vi.fn(async ({ productIds }: { productIds: string[] }) =>
      productIds.map((productId) => ({ resolutionId: `test:${productId}`, productId }))
    ),
    resolveProductForAdd: vi.fn(async ({ productId }: { productId: string }) => ({
      ok: true,
      resolution: { resolutionId: `test:${productId}`, productId },
    })),
    consumeProductResolution: vi.fn(async (_tx: unknown, { productId }: { productId: string }) => ({
      ok: true,
      resolution: { resolutionId: `test:${productId}`, productId, status: 'consumed' },
    })),
  };
});

vi.mock('../../services/draftOrderTimeout.service', () => ({
  refreshDraftOrderTimeout: vi.fn(),
}));
vi.mock('../../services/lastOffer.service', () => ({ clearLastOffer: vi.fn() }));
vi.mock('../../services/pendingVariation.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/pendingVariation.service')>();
  return { ...actual, setPendingVariation: vi.fn(), clearPendingVariation: vi.fn() };
});

import { prisma } from '../../lib/prisma';
import {
  searchProductsTool,
  findProductsByFilterTool,
  getComplementarySuggestionsTool,
  presentCategoryTool,
  addCartItemTool,
  planOrderLinesTool,
} from '../index';

const baseConfigurable = {
  businessId: 'biz-1',
  customerId: 'cust-1',
  customerPhone: '+5491100000000',
  conversationId: 'conv-1',
  conversationStartedAt: '2026-09-27T00:00:00.000Z',
  turnStartedAt: '2026-09-27T16:00:00.000Z',
};

const configWith = (overrides: Record<string, unknown> = {}) => ({
  configurable: { ...baseConfigurable, ...overrides },
});

const CEVICHE_CATEGORY_ID = '11111111-1111-4111-8111-111111111111';

describe('party size ya no bloquea catálogo ni pedido (salvo sugerencias de complemento)', () => {
  let metadata: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    metadata = {};
    findOrCreateConversationState.mockImplementation(async () => ({ metadata }));
    patchConversationMetadata.mockImplementation(
      async (_id: string, patch: Record<string, unknown>) => {
        metadata = { ...metadata, ...patch };
      }
    );
    omitConversationMetadataKeys.mockImplementation(async (_id: string, keys: string[]) => {
      const next = { ...metadata };
      for (const key of keys) delete next[key];
      metadata = next;
    });
  });

  describe('search_products', () => {
    it('sin party size y sin goal activo, permite consultar el catálogo', async () => {
      const result = JSON.parse(
        (await searchProductsTool.func({ keyword: 'ceviche' }, undefined, configWith())) as string
      );

      expect(result.error).toBeUndefined();
      expect(result.count).toBe(1);
      expect(result.items[0].name).toBe('Ceviche Clásico');
    });

    it('sin party size y con goal PEDIR (transaccional), igual permite consultar', async () => {
      const result = JSON.parse(
        (await searchProductsTool.func(
          { keyword: 'ceviche' },
          undefined,
          configWith({ activeHumanIntentGoal: 'PEDIR' })
        )) as string
      );

      expect(result.error).toBeUndefined();
      expect(result.count).toBe(1);
    });

    it('con un pendingPartySizeOrder heredado, responde el catálogo sin pedir personas ni tocar el pending', async () => {
      metadata = {
        pendingPartySizeOrder: {
          source: 'lookup',
          summary: 'milanesa',
          setAt: '2026-09-27T15:00:00.000Z',
        },
      };

      const result = JSON.parse(
        (await searchProductsTool.func(
          { keyword: 'ceviche' },
          undefined,
          configWith({ activeHumanIntentGoal: 'PEDIR' })
        )) as string
      );

      expect(result.error).toBeUndefined();
      expect(result.count).toBe(1);
      expect(metadata.pendingPartySizeOrder).toEqual({
        source: 'lookup',
        summary: 'milanesa',
        setAt: '2026-09-27T15:00:00.000Z',
      });
    });
  });

  describe('find_products_by_filter', () => {
    it('sin party size, con goal PEDIR, permite la lectura', async () => {
      const result = JSON.parse(
        (await findProductsByFilterTool.func(
          { limit: 10 },
          undefined,
          configWith({ activeHumanIntentGoal: 'PEDIR' })
        )) as string
      );

      expect(result.error).toBeUndefined();
      expect(result.count).toBe(0);
    });
  });

  describe('get_complementary_suggestions (fuera de alcance: conserva el gate previo)', () => {
    it('con CONSULTAR_NEGOCIO y sin party size, permite la lectura', async () => {
      const result = JSON.parse(
        (await getComplementarySuggestionsTool.func(
          { limit: 6 },
          undefined,
          configWith({ activeHumanIntentGoal: 'CONSULTAR_NEGOCIO' })
        )) as string
      );

      expect(result.error).toBeUndefined();
      expect(Array.isArray(result.items)).toBe(true);
    });

    it('con PEDIR y sin party size, sigue bloqueando (sin cambios)', async () => {
      const result = JSON.parse(
        (await getComplementarySuggestionsTool.func(
          { limit: 6 },
          undefined,
          configWith({ activeHumanIntentGoal: 'PEDIR' })
        )) as string
      );

      expect(result.error).toBe('party_size_required');
    });
  });

  describe('present_category', () => {
    it('sin party size, con goal PEDIR, permite mostrar la categoría', async () => {
      const result = JSON.parse(
        (await presentCategoryTool.func(
          { categoryId: CEVICHE_CATEGORY_ID },
          undefined,
          configWith({ activeHumanIntentGoal: 'PEDIR' })
        )) as string
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBe('present_category');
    });
  });

  describe('operaciones transaccionales de pedido: ya no exigen party size', () => {
    it('add_cart_item agrega el producto sin Fact de personas', async () => {
      vi.mocked(prisma.menu_item.findFirst).mockResolvedValueOnce({
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Ceviche Clásico',
        serves_people: 1,
        discount_type: null,
        discount_value: null,
        variations: [],
        menu_item_price: [{ amount: new Prisma.Decimal(1000), currency_code: 'ARS' }],
      } as never);

      const result = JSON.parse(
        (await addCartItemTool.func(
          { productId: '22222222-2222-4222-8222-222222222222', quantity: 1 },
          undefined,
          configWith({ activeHumanIntentGoal: 'CONSULTAR_NEGOCIO' })
        )) as string
      );

      expect(result.error).not.toBe('party_size_required');
    });

    it('plan_order_lines acepta el plan sin Fact de personas', async () => {
      const result = JSON.parse(
        (await planOrderLinesTool.func(
          { lines: [{ hint: 'ceviche', requestedQuantity: 1 }] },
          undefined,
          configWith({ activeHumanIntentGoal: 'EXPLORAR' })
        )) as string
      );

      expect(result.error).not.toBe('party_size_required');
    });
  });
});
