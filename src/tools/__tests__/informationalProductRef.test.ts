/**
 * Fase 2 — referente conversacional informativo ("¿cuánto cuesta el
 * ceviche?" → "¿y qué ingredientes tiene?" → "agregame uno").
 *
 * Integra search_products / find_products_by_filter / get_products_details_by_ids
 * / add_cart_item con el servicio `informationalProductRef.service.ts` para
 * comprobar: fijación en match único, no-fijación en ambigüedad o cero
 * resultados, reemplazo por un nuevo match único, separación de lastOffer /
 * carrito, y que "agregame uno" sigue las validaciones normales de
 * ProductResolution (incluido un referente obsoleto/consumido).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { database } = vi.hoisted(() => {
  const state = { metadata: {} as Record<string, unknown> };
  const filterState = { items: [] as unknown[], total: 0 };
  const menuItem = {
    findFirst: vi.fn(),
    count: vi.fn(async () => filterState.total),
    findMany: vi.fn(async ({ where, select }: { where: { id?: { in?: string[] } }; select?: Record<string, unknown> }) => {
      const isResolutionValidityCheck =
        !!select && Object.keys(select).length === 1 && select.id === true;
      if (isResolutionValidityCheck) {
        const ids = where.id?.in ?? [];
        return ids.map((id) => ({ id }));
      }
      return filterState.items;
    }),
  };
  const prisma: any = {
    draft_order: {
      findFirst: vi.fn(async () => ({ id: 'draft-1' })),
      create: vi.fn(),
      update: vi.fn(),
    },
    menu_item: menuItem,
    draft_order_item: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({ id: 'line-1', quantity: 1 })),
      update: vi.fn(),
      aggregate: vi.fn(async () => ({ _sum: { total_price: new Prisma.Decimal(0) } })),
      findMany: vi.fn(async () => []),
    },
    business: { findUnique: vi.fn(async () => ({ currency_code: 'ARS' })) },
    conversation_state: {
      upsert: vi.fn(),
      findUnique: vi.fn(async () => ({ metadata: state.metadata })),
      update: vi.fn(async ({ data }: { data: { metadata: Record<string, unknown> } }) => {
        state.metadata = data.metadata;
        return { metadata: state.metadata };
      }),
    },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('').includes('jsonb_set')) {
        state.metadata.productResolutions = JSON.parse(String(values[0])) as unknown;
      }
      return 1;
    }),
  };
  prisma.$transaction = vi.fn(async (arg: ((tx: typeof prisma) => unknown) | Promise<unknown>[]) =>
    Array.isArray(arg) ? Promise.all(arg) : arg(prisma)
  );
  return { database: { prisma, state, filterState } };
});

vi.mock('../../lib/prisma', () => ({ prisma: database.prisma }));
vi.mock('../../services/menu.service', () => ({
  MenuService: { searchMenuItemsByKeyword: vi.fn() },
}));
vi.mock('../../services/ordersCapabilityGate.service', () => ({
  assertCanOrder: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../services/draftOrderTimeout.service', () => ({ refreshDraftOrderTimeout: vi.fn() }));
vi.mock('../../services/lastOffer.service', () => ({ clearLastOffer: vi.fn() }));
vi.mock('../../services/pendingVariation.service', () => ({
  clearPendingVariation: vi.fn(),
  setPendingVariation: vi.fn(),
}));
vi.mock('../../services/pendingAddQuantity.service', () => ({
  clearPendingAddQuantity: vi.fn(),
  getPendingAddQuantity: vi.fn().mockReturnValue(null),
  isPendingAddQuantityReply: vi.fn().mockReturnValue(false),
  setPendingAddQuantity: vi.fn(),
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
vi.mock('../../services/intent/promotionOpportunity.service', () => ({
  resolvePostAddPromotion: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../repositories/conversationState.repository', () => ({
  patchConversationMetadata: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
    database.state.metadata = { ...database.state.metadata, ...patch };
  }),
  omitConversationMetadataKeys: vi.fn(async (_id: string, keys: string[]) => {
    for (const key of keys) delete database.state.metadata[key];
  }),
}));
vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: vi.fn(async () => ({ metadata: database.state.metadata })),
    mutateConversationMetadata: vi.fn(async (
      _conversationId: string,
      mutate: (metadata: Record<string, unknown>) => {
        metadata: Record<string, unknown> | null;
        result: unknown;
      }
    ) => {
      const mutation = mutate(database.state.metadata);
      if (mutation.metadata) database.state.metadata = mutation.metadata;
      return mutation.result;
    }),
  };
});

import { MenuService } from '../../services/menu.service';
import {
  addCartItemTool,
  findProductsByFilterTool,
  getProductsDetailsByIdsTool,
  searchProductsTool,
} from '../index';
import { prisma } from '../../lib/prisma';
import { getInformationalProductRef } from '../../services/informationalProductRef.service';

const BUSINESS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONVERSATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CEVICHE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MILANESA_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

const CEVICHE = {
  id: CEVICHE_ID,
  name: 'Ceviche Clásico',
  description: 'Pescado fresco',
  ingredients: 'Pescado, limón',
  preparation: null,
  ingredients_notes: null,
  serves_people: 2,
  is_available: true,
  is_featured: false,
  category_id: null,
  category_name: null,
  category_tag: null,
  variations: [],
  discount_type: null,
  discount_value: null,
  menu_category: { id: 'cat-1', name: 'Entradas', category_tag: 'STARTER' },
  menu_item_price: [{ amount: new Prisma.Decimal(1000), currency_code: 'ARS' }],
};

const MILANESA = {
  ...CEVICHE,
  id: MILANESA_ID,
  name: 'Milanesa Napolitana',
  category_id: null,
  menu_category: { id: 'cat-2', name: 'Principales', category_tag: 'MAIN' },
  menu_item_price: [{ amount: new Prisma.Decimal(2000), currency_code: 'ARS' }],
};

const configFor = (turnId: string, overrides: Record<string, unknown> = {}) => ({
  configurable: {
    businessId: BUSINESS_ID,
    customerId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    customerPhone: '+5491100000000',
    conversationId: CONVERSATION_ID,
    conversationStartedAt: new Date().toISOString(),
    turnStartedAt: new Date().toISOString(),
    turnId,
    ...overrides,
  },
});

describe('referente informativo de producto (Fase 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    database.state.metadata = {};
    database.filterState.items = [];
    database.filterState.total = 0;
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: new Prisma.Decimal(0) },
    } as never);
  });

  it('1) un único resultado de search_products conserva un referente utilizable', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([CEVICHE] as never);

    await searchProductsTool.func({ keyword: 'ceviche' }, undefined, configFor('turn-1'));

    const ref = getInformationalProductRef(database.state.metadata);
    expect(ref).toMatchObject({ productId: CEVICHE_ID, name: 'Ceviche Clásico' });
  });

  it('2) una pregunta de seguimiento sin nombrar el producto puede resolverse con el referente (get_products_details_by_ids)', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([CEVICHE] as never);
    await searchProductsTool.func({ keyword: 'ceviche' }, undefined, configFor('turn-1'));

    const ref = getInformationalProductRef(database.state.metadata);
    expect(ref).not.toBeNull();

    database.filterState.items = [CEVICHE];
    const result = JSON.parse(
      (await getProductsDetailsByIdsTool.func(
        { productIds: [ref!.productId] },
        undefined,
        configFor('turn-2')
      )) as string
    );

    expect(result.items[0]).toMatchObject({ id: CEVICHE_ID, ingredients: 'Pescado, limón' });
  });

  it('3) una búsqueda explícita de otro producto reemplaza el referente anterior', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValueOnce([CEVICHE] as never);
    await searchProductsTool.func({ keyword: 'ceviche' }, undefined, configFor('turn-1'));
    expect(getInformationalProductRef(database.state.metadata)).toMatchObject({ productId: CEVICHE_ID });

    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValueOnce([MILANESA] as never);
    await searchProductsTool.func({ keyword: 'milanesa' }, undefined, configFor('turn-2'));

    expect(getInformationalProductRef(database.state.metadata)).toMatchObject({ productId: MILANESA_ID });
  });

  it('4) una búsqueda con múltiples resultados no fija un producto arbitrario', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([CEVICHE, MILANESA] as never);

    await searchProductsTool.func({ keyword: 'plato' }, undefined, configFor('turn-1'));

    expect(getInformationalProductRef(database.state.metadata)).toBeNull();
  });

  it('4b) tampoco lo fija find_products_by_filter con múltiples resultados, pero sí con uno solo', async () => {
    database.filterState.items = [CEVICHE, MILANESA];
    database.filterState.total = 2;
    await findProductsByFilterTool.func({ limit: 10 }, undefined, configFor('turn-1'));
    expect(getInformationalProductRef(database.state.metadata)).toBeNull();

    database.filterState.items = [CEVICHE];
    database.filterState.total = 1;
    await findProductsByFilterTool.func({ limit: 10 }, undefined, configFor('turn-2'));
    expect(getInformationalProductRef(database.state.metadata)).toMatchObject({ productId: CEVICHE_ID });
  });

  it('4c) get_products_details_by_ids con un único producto fija el referente, sin búsqueda previa', async () => {
    database.filterState.items = [CEVICHE];
    await getProductsDetailsByIdsTool.func(
      { productIds: [CEVICHE_ID] },
      undefined,
      configFor('turn-1')
    );

    expect(getInformationalProductRef(database.state.metadata)).toMatchObject({ productId: CEVICHE_ID });
  });

  it('4d) get_products_details_by_ids con varios productos no fija ninguno (ambigüedad)', async () => {
    database.filterState.items = [CEVICHE, MILANESA];
    await getProductsDetailsByIdsTool.func(
      { productIds: [CEVICHE_ID, MILANESA_ID] },
      undefined,
      configFor('turn-1')
    );

    expect(getInformationalProductRef(database.state.metadata)).toBeNull();
  });

  it('4e) get_products_details_by_ids con varios productos no pisa un referente único previo', async () => {
    database.filterState.items = [CEVICHE];
    await getProductsDetailsByIdsTool.func(
      { productIds: [CEVICHE_ID] },
      undefined,
      configFor('turn-1')
    );
    expect(getInformationalProductRef(database.state.metadata)).toMatchObject({ productId: CEVICHE_ID });

    database.filterState.items = [CEVICHE, MILANESA];
    await getProductsDetailsByIdsTool.func(
      { productIds: [CEVICHE_ID, MILANESA_ID] },
      undefined,
      configFor('turn-2')
    );

    // Ambigüedad: no se borra ni se reemplaza por una elección arbitraria.
    expect(getInformationalProductRef(database.state.metadata)).toMatchObject({ productId: CEVICHE_ID });
  });

  it('5) una búsqueda sin resultados no inventa ni selecciona un producto', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([] as never);

    await searchProductsTool.func({ keyword: 'inexistente' }, undefined, configFor('turn-1'));

    expect(getInformationalProductRef(database.state.metadata)).toBeNull();
  });

  it('6) una consulta informativa no escribe lastOffer ni crea una oportunidad comercial', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([CEVICHE] as never);
    await searchProductsTool.func({ keyword: 'ceviche' }, undefined, configFor('turn-1'));

    database.filterState.items = [CEVICHE];
    await getProductsDetailsByIdsTool.func({ productIds: [CEVICHE_ID] }, undefined, configFor('turn-2'));

    expect(database.state.metadata.lastOffer).toBeUndefined();
    expect((database.state.metadata.intentLedger as Record<string, unknown> | undefined)?.CONFIRMAR_OFERTA).toBeUndefined();
  });

  it('7) una consulta informativa no modifica el carrito ni crea líneas de pedido', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([CEVICHE] as never);
    await searchProductsTool.func({ keyword: 'ceviche' }, undefined, configFor('turn-1'));
    database.filterState.items = [CEVICHE];
    await getProductsDetailsByIdsTool.func({ productIds: [CEVICHE_ID] }, undefined, configFor('turn-2'));

    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    expect(database.state.metadata.pendingOrderLines).toBeUndefined();
  });

  it('8) "agregame uno" usa el referente para add_cart_item en un turno posterior y pasa por las validaciones normales', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([CEVICHE] as never);
    await searchProductsTool.func({ keyword: 'ceviche' }, undefined, configFor('turn-1'));
    const ref = getInformationalProductRef(database.state.metadata);
    expect(ref).not.toBeNull();

    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(CEVICHE as never);

    const result = JSON.parse(
      (await addCartItemTool.func(
        { productId: ref!.productId, quantity: 1 },
        undefined,
        configFor('turn-2')
      )) as string
    );

    expect(result.success).toBe(true);
    expect(prisma.draft_order_item.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ product_id: CEVICHE_ID, quantity: 1 }) })
    );
  });

  it('9) un referente ya consumido no permite agregar de nuevo sin volver a resolverlo', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([CEVICHE] as never);
    await searchProductsTool.func({ keyword: 'ceviche' }, undefined, configFor('turn-1'));
    const ref = getInformationalProductRef(database.state.metadata);
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(CEVICHE as never);

    const first = JSON.parse(
      (await addCartItemTool.func(
        { productId: ref!.productId, quantity: 1 },
        undefined,
        configFor('turn-2')
      )) as string
    );
    expect(first.success).toBe(true);

    // El primer add ya limpió el referente informativo (fix del bug de
    // staleness); igual lo demuestra: su ProductResolution quedó 'consumed'
    // y un segundo intento sin volver a buscar/resolver debe fallar, no
    // agregar de nuevo gratis.
    const second = JSON.parse(
      (await addCartItemTool.func(
        { productId: ref!.productId, quantity: 1 },
        undefined,
        configFor('turn-3')
      )) as string
    );
    expect(second.success).toBe(false);
    expect(second.error).toBe('product_resolution_required');
  });

  it('9b) el referente de un producto distinto no autoriza agregar un producto sin resolución propia', async () => {
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([CEVICHE] as never);
    await searchProductsTool.func({ keyword: 'ceviche' }, undefined, configFor('turn-1'));
    // Referente: Ceviche. Intento de add sobre Milanesa, que nunca se buscó
    // ni tiene ProductResolution propia.
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(MILANESA as never);

    const result = JSON.parse(
      (await addCartItemTool.func(
        { productId: MILANESA_ID, quantity: 1 },
        undefined,
        configFor('turn-2')
      )) as string
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('product_resolution_required');
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
  });

  it('10) un add_cart_item exitoso limpia un lastInformationalProductRef obsoleto (fix del bug de staleness)', async () => {
    // Simula el camino real del bug: una ambigüedad de milanesa se resolvió
    // vía resolve_product (que no toca lastInformationalProductRef) en vez
    // de una nueva búsqueda de match único — el referente quedó apuntando al
    // ceviche de un turno anterior, sin relación con lo que se va a agregar.
    database.state.metadata.lastInformationalProductRef = {
      productId: CEVICHE_ID,
      name: 'Ceviche Clásico',
      setAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    database.state.metadata.pendingProductSelection = true;
    database.state.metadata.candidateProductIds = [MILANESA_ID, 'otra-milanesa-id'];

    database.filterState.items = [MILANESA];
    database.filterState.total = 1;
    await findProductsByFilterTool.func({ limit: 10 }, undefined, configFor('turn-1'));
    const milanesaRef = database.state.metadata.productResolutions as Array<{ productId: string; resolutionId: string }>;
    const resolutionId = milanesaRef.find((r) => r.productId === MILANESA_ID)!.resolutionId;

    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(MILANESA as never);
    const added = JSON.parse(
      (await addCartItemTool.func(
        { productId: MILANESA_ID, resolutionId, quantity: 1 },
        undefined,
        configFor('turn-2')
      )) as string
    );

    expect(added.success).toBe(true);
    // El referente obsoleto (ceviche) ya no existe tras el add exitoso.
    expect(getInformationalProductRef(database.state.metadata)).toBeNull();
    expect(database.state.metadata.lastInformationalProductRef).toBeUndefined();
    // El estado de selección pendiente sigue limpiándose igual que antes.
    expect(database.state.metadata.pendingProductSelection).toBeUndefined();
    expect(database.state.metadata.candidateProductIds).toBeUndefined();
  });

  it('11) si add_cart_item falla, el fix no borra el referente informativo', async () => {
    database.state.metadata.lastInformationalProductRef = {
      productId: CEVICHE_ID,
      name: 'Ceviche Clásico',
      setAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    // Milanesa sin ninguna ProductResolution propia: el add debe rechazarse.
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(MILANESA as never);

    const result = JSON.parse(
      (await addCartItemTool.func(
        { productId: MILANESA_ID, quantity: 1 },
        undefined,
        configFor('turn-1')
      )) as string
    );

    expect(result.success).toBe(false);
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    expect(getInformationalProductRef(database.state.metadata)).toMatchObject({ productId: CEVICHE_ID });
  });
});
