/**
 * Las tools de lectura de catálogo (search_products, find_products_by_filter,
 * get_complementary_suggestions, present_category) no deben exigir
 * OBTENER_PERSONAS_DEL_PEDIDO cuando el HumanIntent ACTIVE del turno es
 * puramente informativo (CONSULTAR_NEGOCIO/EXPLORAR). Las operaciones
 * transaccionales (add_cart_item, plan_order_lines) conservan el gate
 * incondicional, pasen o no un goal activo por configurable.
 *
 * Ver docs/arquitectura (auditoría "separar lectura de catálogo y
 * precondición de party size") para el diagnóstico completo.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const findOrCreateConversationState = vi.fn();
const patchConversationMetadata = vi.fn();
const omitConversationMetadataKeys = vi.fn();

vi.mock('../../lib/prisma', () => ({
  prisma: {
    business: { findUnique: vi.fn().mockResolvedValue({ currency_code: 'ARS' }) },
    menu_item: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

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
  };
});

import { prisma } from '../../lib/prisma';
import { searchProductsTool, findProductsByFilterTool, getComplementarySuggestionsTool, presentCategoryTool, addCartItemTool, planOrderLinesTool } from '../index';

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

describe('gate de party size en tools informativas de catálogo', () => {
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
    it('con CONSULTAR_NEGOCIO y sin party size, permite consultar el catálogo', async () => {
      const result = JSON.parse(
        (await searchProductsTool.func(
          { keyword: 'ceviche' },
          undefined,
          configWith({ activeHumanIntentGoal: 'CONSULTAR_NEGOCIO' })
        )) as string
      );

      expect(result.error).toBeUndefined();
      expect(result.count).toBe(1);
      expect(result.items[0].name).toBe('Ceviche Clásico');
    });

    it('con EXPLORAR y sin party size, permite explorar el catálogo', async () => {
      const result = JSON.parse(
        (await searchProductsTool.func(
          { keyword: 'ceviche' },
          undefined,
          configWith({ activeHumanIntentGoal: 'EXPLORAR' })
        )) as string
      );

      expect(result.error).toBeUndefined();
      expect(result.count).toBe(1);
    });

    it('con PEDIR y sin party size, conserva el bloqueo actual', async () => {
      const result = JSON.parse(
        (await searchProductsTool.func(
          { keyword: 'ceviche' },
          undefined,
          configWith({ activeHumanIntentGoal: 'PEDIR' })
        )) as string
      );

      expect(result.error).toBe('party_size_required');
      expect(result.pending).toBe(true);
    });

    it('sin goal activo (señal ausente), mantiene el comportamiento conservador', async () => {
      const result = JSON.parse(
        (await searchProductsTool.func({ keyword: 'ceviche' }, undefined, configWith())) as string
      );

      expect(result.error).toBe('party_size_required');
    });

    it('no produce ningún efecto transaccional (sin campo "effect" en la respuesta)', async () => {
      const result = JSON.parse(
        (await searchProductsTool.func(
          { keyword: 'ceviche' },
          undefined,
          configWith({ activeHumanIntentGoal: 'CONSULTAR_NEGOCIO' })
        )) as string
      );

      expect(result.effect).toBeUndefined();
    });

    it('con un pendingPartySizeOrder ya existente, responde el catálogo sin tocar el pending', async () => {
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
          configWith({ activeHumanIntentGoal: 'CONSULTAR_NEGOCIO' })
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
    it('con intención informativa (CONSULTAR_NEGOCIO) permite la lectura', async () => {
      const result = JSON.parse(
        (await findProductsByFilterTool.func(
          { limit: 10 },
          undefined,
          configWith({ activeHumanIntentGoal: 'CONSULTAR_NEGOCIO' })
        )) as string
      );

      expect(result.error).toBeUndefined();
      expect(result.count).toBe(0);
    });

    it('con PEDIR y sin party size, conserva el bloqueo', async () => {
      const result = JSON.parse(
        (await findProductsByFilterTool.func(
          { limit: 10 },
          undefined,
          configWith({ activeHumanIntentGoal: 'PEDIR' })
        )) as string
      );

      expect(result.error).toBe('party_size_required');
    });

    it('no produce ningún efecto transaccional', async () => {
      const result = JSON.parse(
        (await findProductsByFilterTool.func(
          { limit: 10 },
          undefined,
          configWith({ activeHumanIntentGoal: 'EXPLORAR' })
        )) as string
      );

      expect(result.effect).toBeUndefined();
    });
  });

  describe('get_complementary_suggestions', () => {
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

    it('con PEDIR y sin party size, conserva el bloqueo', async () => {
      const result = JSON.parse(
        (await getComplementarySuggestionsTool.func(
          { limit: 6 },
          undefined,
          configWith({ activeHumanIntentGoal: 'PEDIR' })
        )) as string
      );

      expect(result.error).toBe('party_size_required');
    });

    it('no toca conversation metadata (no hay efecto transaccional ni de pendings)', async () => {
      await getComplementarySuggestionsTool.func(
        { limit: 6 },
        undefined,
        configWith({ activeHumanIntentGoal: 'CONSULTAR_NEGOCIO' })
      );

      expect(patchConversationMetadata).not.toHaveBeenCalled();
    });
  });

  describe('present_category', () => {
    it('con EXPLORAR y sin party size, permite mostrar la categoría', async () => {
      const result = JSON.parse(
        (await presentCategoryTool.func(
          { categoryId: CEVICHE_CATEGORY_ID },
          undefined,
          configWith({ activeHumanIntentGoal: 'EXPLORAR' })
        )) as string
      );

      expect(result.error).toBeUndefined();
      expect(result.signal).toBe('present_category');
    });

    it('con PEDIR y sin party size, conserva el bloqueo', async () => {
      const result = JSON.parse(
        (await presentCategoryTool.func(
          { categoryId: CEVICHE_CATEGORY_ID },
          undefined,
          configWith({ activeHumanIntentGoal: 'PEDIR' })
        )) as string
      );

      expect(result.error).toBe('party_size_required');
    });

    it('no toca conversation metadata', async () => {
      await presentCategoryTool.func(
        { categoryId: CEVICHE_CATEGORY_ID },
        undefined,
        configWith({ activeHumanIntentGoal: 'EXPLORAR' })
      );

      expect(patchConversationMetadata).not.toHaveBeenCalled();
    });
  });

  describe('operaciones transaccionales: gate intacto sin importar activeHumanIntentGoal', () => {
    it('add_cart_item sigue bloqueando sin party size aunque el goal activo sea informativo', async () => {
      vi.mocked(prisma.menu_item.findFirst).mockResolvedValueOnce({
        id: '22222222-2222-4222-8222-222222222222',
        name: 'Ceviche Clásico',
        serves_people: 1,
        discount_type: null,
        discount_value: null,
        variations: [],
        menu_item_price: [{ amount: 1000, currency_code: 'ARS' }],
      } as never);

      const result = JSON.parse(
        (await addCartItemTool.func(
          { productId: '22222222-2222-4222-8222-222222222222', quantity: 1 },
          undefined,
          configWith({ activeHumanIntentGoal: 'CONSULTAR_NEGOCIO' })
        )) as string
      );

      expect(result.error).toBe('party_size_required');
    });

    it('plan_order_lines sigue bloqueando sin party size aunque el goal activo sea informativo', async () => {
      const result = JSON.parse(
        (await planOrderLinesTool.func(
          { lines: [{ hint: 'ceviche', requestedQuantity: 1 }] },
          undefined,
          configWith({ activeHumanIntentGoal: 'EXPLORAR' })
        )) as string
      );

      expect(result.error).toBe('party_size_required');
    });
  });
});
