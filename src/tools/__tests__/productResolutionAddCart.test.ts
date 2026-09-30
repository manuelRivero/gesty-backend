import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { database } = vi.hoisted(() => {
  const state = {
    metadata: { peopleCount: 1, requestedPartySize: 1 } as Record<string, unknown>,
  };
  const menuItem = {
    findFirst: vi.fn(),
    findMany: vi.fn(async ({ where }: { where: { id?: { in?: string[] } } }) => {
      const ids = where.id?.in;
      return ids ? ids.map((id) => ({ id })) : [];
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
      create: vi.fn(async () => ({ id: 'line-1', quantity: 4 })),
      update: vi.fn(),
      aggregate: vi.fn(),
      findMany: vi.fn(async () => []),
    },
    business: { findUnique: vi.fn(async () => ({ currency_code: 'ARS' })) },
    conversation_state: {
      upsert: vi.fn(),
      findUnique: vi.fn(async () => ({ metadata: state.metadata })),
    },
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('').includes('jsonb_set')) {
        state.metadata.productResolutions = JSON.parse(String(values[0])) as unknown;
      }
      return 1;
    }),
  };
  prisma.$transaction = vi.fn(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return { database: { prisma, state } };
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
vi.mock('../../services/pendingOrderLines.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/pendingOrderLines.service')>();
  return { ...actual, advanceAfterLineClose: vi.fn().mockResolvedValue(null) };
});
vi.mock('../../services/partySizeGoal.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/partySizeGoal.service')>();
  return {
    ...actual,
    isPartySizeMissingForOrderingTools: vi.fn().mockReturnValue(false),
    clearPendingPartySizeOrder: vi.fn(),
  };
});
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
  };
});

import { MenuService } from '../../services/menu.service';
import * as productResolutionService from '../../services/productResolution.service';
import { addCartItemTool, resolveProductTool, searchProductsTool } from '../index';
import { prisma } from '../../lib/prisma';

const BUSINESS_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONVERSATION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRODUCT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_PRODUCT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const THIRD_PRODUCT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PRODUCT = {
  id: PRODUCT_ID,
  name: 'Producto de prueba',
  serves_people: 1,
  category_id: null,
  category_name: null,
  category_tag: null,
  variations: [],
  discount_type: null,
  discount_value: null,
  menu_item_price: [{ amount: new Prisma.Decimal(100), currency_code: 'ARS' }],
};

const CONFIG = {
  configurable: {
    businessId: BUSINESS_ID,
    customerId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    customerPhone: '+5491100000000',
    conversationId: CONVERSATION_ID,
    conversationStartedAt: new Date().toISOString(),
    turnStartedAt: new Date().toISOString(),
    turnId: 'turn-product-resolution',
    userMessage: 'Quiero 4 productos de prueba',
  },
};

describe('search_products → ProductResolution → add_cart_item', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    database.state.metadata = { peopleCount: 1, requestedPartySize: 1 };
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([PRODUCT] as never);
    vi.mocked(prisma.menu_item.findFirst).mockResolvedValue(PRODUCT as never);
    vi.mocked(prisma.draft_order_item.aggregate).mockResolvedValue({
      _sum: { total_price: new Prisma.Decimal(400) },
    } as never);
  });

  it('sigue rechazando un productId que no tiene formato UUID', () => {
    expect(
      addCartItemTool.schema.safeParse({ productId: 'ceviche', quantity: 4 }).success
    ).toBe(false);
  });

  it('escribe el producto buscado y consume la resolución en la transacción', async () => {
    const resolveProductForAddSpy = vi.spyOn(productResolutionService, 'resolveProductForAdd');
    const search = JSON.parse(
      (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, CONFIG)) as string
    );
    const resolutionId = search.items[0].resolutionId as string;
    expect(resolutionId).toContain(`pr1:${BUSINESS_ID}:${CONVERSATION_ID}:`);

    const add = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, resolutionId, quantity: 4 },
        undefined,
        CONFIG
      )) as string
    );

    expect(add.success).toBe(true);
    expect(add.effect).toMatchObject({ kind: 'cart_item_persisted', reference: PRODUCT_ID });
    expect(prisma.draft_order_item.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ product_id: PRODUCT_ID, quantity: 4 }) })
    );
    expect(database.state.metadata.productResolutions).toEqual([
      expect.objectContaining({
        resolutionId,
        productId: PRODUCT_ID,
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        status: 'consumed',
      }),
    ]);
    expect(resolveProductForAddSpy).toHaveBeenCalledOnce();
  });

  it('consume la resolución inter-step sin volver a ejecutar resolveProductForAdd', async () => {
    const resolveProductForAddSpy = vi.spyOn(productResolutionService, 'resolveProductForAdd');
    const search = JSON.parse(
      (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, CONFIG)) as string
    );
    const resolutionId = search.items[0].resolutionId as string;
    const resolution = JSON.parse(
      (await resolveProductTool.func({ productId: PRODUCT_ID, resolutionId }, undefined, CONFIG)) as string
    );

    const add = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, resolutionId, quantity: 4 },
        undefined,
        {
          ...CONFIG,
          configurable: {
            ...CONFIG.configurable,
            validatedProductResolutionFromExecutionContext: resolution,
          },
        }
      )) as string
    );

    expect(resolution.success).toBe(true);
    expect(add.success).toBe(true);
    expect(resolveProductForAddSpy).not.toHaveBeenCalled();
    expect(database.state.metadata.productResolutions).toEqual([
      expect.objectContaining({ resolutionId, productId: PRODUCT_ID, status: 'consumed' }),
    ]);
  });

  it('mantiene aisladas las resoluciones inter-step de dos productos', async () => {
    const resolveProductForAddSpy = vi.spyOn(productResolutionService, 'resolveProductForAdd');
    const secondProduct = { ...PRODUCT, id: THIRD_PRODUCT_ID, name: 'Otro producto' };
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([PRODUCT, secondProduct] as never);
    const search = JSON.parse(
      (await searchProductsTool.func({ keyword: 'productos' }, undefined, CONFIG)) as string
    );
    const resolutions = await Promise.all(
      search.items.map(async (item: { id: string; resolutionId: string }) => ({
        productId: item.id,
        value: JSON.parse(
          (await resolveProductTool.func(
            { productId: item.id, resolutionId: item.resolutionId },
            undefined,
            CONFIG
          )) as string
        ),
      }))
    );

    const adds = await Promise.all(
      resolutions.map(async ({ productId, value }) =>
        JSON.parse(
          (await addCartItemTool.func(
            { productId, resolutionId: value.resolutionId, quantity: 1 },
            undefined,
            {
              ...CONFIG,
              configurable: {
                ...CONFIG.configurable,
                validatedProductResolutionFromExecutionContext: value,
              },
            }
          )) as string
        )
      )
    );

    expect(resolutions.map(({ value }) => value.productId)).toEqual([PRODUCT_ID, THIRD_PRODUCT_ID]);
    expect(adds.every((add) => add.success)).toBe(true);
    expect(database.prisma.draft_order_item.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ data: expect.objectContaining({ product_id: PRODUCT_ID }) })
    );
    expect(database.prisma.draft_order_item.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ data: expect.objectContaining({ product_id: THIRD_PRODUCT_ID }) })
    );
    expect(resolveProductForAddSpy).not.toHaveBeenCalled();
  });

  it('no persiste con una resolución inter-step inválida', async () => {
    const search = JSON.parse(
      (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, CONFIG)) as string
    );
    const resolutionId = search.items[0].resolutionId as string;
    const resolution = JSON.parse(
      (await resolveProductTool.func({ productId: PRODUCT_ID, resolutionId }, undefined, CONFIG)) as string
    );

    const add = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, resolutionId: 'pr1:other:other:invalid', quantity: 4 },
        undefined,
        {
          ...CONFIG,
          configurable: {
            ...CONFIG.configurable,
            validatedProductResolutionFromExecutionContext: resolution,
          },
        }
      )) as string
    );

    expect(add).toMatchObject({ success: false, error: 'product_resolution_required' });
    expect(add.effect).toBeUndefined();
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
  });

  it('no agrega un candidato ambiguo hasta que resolve_product lo seleccione', async () => {
    const otherProduct = { ...PRODUCT, id: OTHER_PRODUCT_ID, name: 'Otra opción' };
    vi.mocked(MenuService.searchMenuItemsByKeyword).mockResolvedValue([
      PRODUCT,
      otherProduct,
    ] as never);

    const search = JSON.parse(
      (await searchProductsTool.func({ keyword: 'catálogo' }, undefined, CONFIG)) as string
    );
    const resolutionId = search.items[0].resolutionId as string;
    expect(search.items).toHaveLength(2);

    const blocked = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, quantity: 4 },
        undefined,
        CONFIG
      )) as string
    );
    expect(blocked).toMatchObject({
      success: false,
      error: 'product_resolution_required',
      reason: 'resolution_not_selected',
    });
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();

    const selectionTurn = {
      configurable: {
        ...CONFIG.configurable,
        turnId: 'turn-product-selection',
        turnStartedAt: new Date().toISOString(),
        userMessage: 'el primero',
      },
    };
    const selected = JSON.parse(
      (await resolveProductTool.func(
        { productId: PRODUCT_ID, resolutionId },
        undefined,
        selectionTurn
      )) as string
    );
    expect(selected.success).toBe(true);

    const added = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, resolutionId, quantity: 4 },
        undefined,
        selectionTurn
      )) as string
    );
    expect(added.success).toBe(true);
    expect(prisma.draft_order_item.create).toHaveBeenCalledTimes(1);
  });
});