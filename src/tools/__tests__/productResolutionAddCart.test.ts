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
  prisma.$transaction = vi.fn(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
  return { database: { prisma, state } };
});

vi.mock('../../lib/prisma', () => ({ prisma: database.prisma }));
vi.mock('../../services/humanIntentReconciliation.service', () => ({
  reconcileHumanIntentAfterToolEffect: vi.fn().mockResolvedValue(null),
}));
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
  return { ...actual, advanceAfterLineClose: vi.fn(actual.advanceAfterLineClose) };
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
import * as productResolutionService from '../../services/productResolution.service';
import {
  addCartItemTool,
  continueOrderLineTool as continueOrderLineToolForTests,
  resolveProductTool,
  searchProductsTool,
  setOrderLineQuantityTool,
} from '../index';
import { prisma } from '../../lib/prisma';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { PostEffectToolNode } from '../../agents/postEffectToolNode';
import { completesTask } from '../../agents/humanIntentToolNode';
import { getFulfillmentReadyOrderLine, getPendingOrderLines } from '../../services/pendingOrderLines.service';

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

  it('asocia una resolución correcta a la task explícita durante la resolución del producto', async () => {
    database.state.metadata.pendingOrderLines = {
      lines: [{ id: 'task-1', hint: 'Producto de prueba', requestedQuantity: null, status: 'active', currentResolutionId: null }],
      sourceMessage: 'Quiero producto de prueba',
      createdAt: new Date().toISOString(),
    };

    const search = JSON.parse(
      (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, CONFIG)) as string
    );
    const resolutionId = search.items[0].resolutionId as string;

    const resolution = JSON.parse(
      (await resolveProductTool.func(
        { productId: PRODUCT_ID, resolutionId, orderLineId: 'task-1' },
        undefined,
        CONFIG
      )) as string
    );

    expect(resolution.success).toBe(true);
    expect(database.state.metadata.pendingOrderLines).toMatchObject({
      lines: [{ id: 'task-1', currentResolutionId: resolutionId }],
    });
  });

  describe('Fact semántico de cantidad del turno (parseBareQuantityReply) → autorización de set_order_line_quantity', () => {
    // Misma línea ACTIVE + resolución propia para los 5 casos; cada test solo
    // varía el userMessage y/o el quantity que "propone" el modelo.
    const seedActiveTask = () => {
      const resolutionId = `pr1:${BUSINESS_ID}:${CONVERSATION_ID}:bare-quantity-fact`;
      database.state.metadata = {
        peopleCount: 4,
        requestedPartySize: 4,
        pendingOrderLines: {
          sourceMessage: 'ceviche',
          createdAt: new Date().toISOString(),
          lines: [{
            id: 'task-quantity',
            hint: 'ceviche',
            requestedQuantity: null,
            status: 'active',
            currentResolutionId: resolutionId,
          }],
        },
        productResolutions: [{
          resolutionId,
          productId: PRODUCT_ID,
          businessId: BUSINESS_ID,
          conversationId: CONVERSATION_ID,
          source: 'search_products',
          status: 'selected',
          scope: 'conversation',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }],
      };
    };
    const setQuantity = (quantity: number, userMessage: string) => setOrderLineQuantityTool.func(
      { orderLineId: 'task-quantity', quantity },
      undefined,
      { ...CONFIG, configurable: { ...CONFIG.configurable, userMessage } }
    ) as Promise<string>;

    it('TEST A — cantidad numérica ("1") persiste quantity=1', async () => {
      seedActiveTask();

      const result = JSON.parse(await setQuantity(1, '1'));

      expect(result).toMatchObject({ success: true, orderLine: { id: 'task-quantity', requestedQuantity: 1 } });
      expect(database.state.metadata.pendingOrderLines).toMatchObject({
        lines: [{ id: 'task-quantity', requestedQuantity: 1 }],
      });
    });

    it('TEST B — cardinal textual bare ("Una") persiste quantity=1 — el caso reportado', async () => {
      seedActiveTask();

      const result = JSON.parse(await setQuantity(1, 'Una'));

      expect(result).toMatchObject({ success: true, orderLine: { id: 'task-quantity', requestedQuantity: 1 } });
      expect(database.state.metadata.pendingOrderLines).toMatchObject({
        lines: [{ id: 'task-quantity', requestedQuantity: 1 }],
      });
    });

    it('TEST C — variante lingüística ("Dame una") ya resuelta por la capa semántica existente', async () => {
      seedActiveTask();

      const result = JSON.parse(await setQuantity(1, 'Dame una'));

      expect(result).toMatchObject({ success: true, orderLine: { id: 'task-quantity', requestedQuantity: 1 } });
    });

    it('TEST D — cardinal textual bare ("Dos") persiste quantity=2', async () => {
      seedActiveTask();

      const result = JSON.parse(await setQuantity(2, 'Dos'));

      expect(result).toMatchObject({ success: true, orderLine: { id: 'task-quantity', requestedQuantity: 2 } });
    });

    it('TEST E — sin Fact de cantidad en el mensaje, quantity=1 inventado por el modelo se rechaza', async () => {
      seedActiveTask();

      const result = JSON.parse(await setQuantity(1, 'Quiero el ceviche'));

      expect(result).toMatchObject({ success: false, error: 'quantity_not_confirmed_by_user_message' });
      expect(database.state.metadata.pendingOrderLines).toMatchObject({
        lines: [{ id: 'task-quantity', requestedQuantity: null }],
      });
    });
  });

  it('TEST F — "Para N" nunca confirma CANTIDAD_DEL_PRODUCTO, ni con el Goal de cantidad activo', async () => {
    const resolutionId = `pr1:${BUSINESS_ID}:${CONVERSATION_ID}:quantity-goal-reply`;
    database.state.metadata = {
      peopleCount: 4,
      requestedPartySize: 4,
      pendingOrderLines: {
        sourceMessage: 'ceviche',
        createdAt: new Date().toISOString(),
        lines: [{
          id: 'task-quantity',
          hint: 'ceviche',
          requestedQuantity: null,
          status: 'active',
          currentResolutionId: resolutionId,
        }],
      },
      productResolutions: [{
        resolutionId,
        productId: PRODUCT_ID,
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
        source: 'search_products',
        status: 'selected',
        scope: 'conversation',
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }],
    };

    const withoutGoal = JSON.parse((await setOrderLineQuantityTool.func(
      { orderLineId: 'task-quantity', quantity: 3 },
      undefined,
      { ...CONFIG, configurable: { ...CONFIG.configurable, userMessage: 'Para 3' } }
    )) as string);
    expect(withoutGoal).toMatchObject({
      success: false,
      error: 'quantity_not_confirmed_by_user_message',
    });

    // El Fact de personas (PERSONAS_DEL_PEDIDO) sigue siendo distinto de
    // CANTIDAD_DEL_PRODUCTO aunque el Goal de cantidad esté abierto y el modelo
    // haya pasado quantity=3: "Para 3" no es una respuesta a "¿cuántas unidades?".
    const withGoal = JSON.parse((await setOrderLineQuantityTool.func(
      { orderLineId: 'task-quantity', quantity: 3 },
      undefined,
      {
        ...CONFIG,
        configurable: {
          ...CONFIG.configurable,
          userMessage: 'Para 3',
          activeBlockingGoal: 'OBTENER_CANTIDAD_DEL_PRODUCTO',
        },
      }
    )) as string);

    expect(withGoal).toMatchObject({
      success: false,
      error: 'quantity_not_confirmed_by_user_message',
    });
    expect(database.state.metadata.pendingOrderLines).toMatchObject({
      lines: [{ id: 'task-quantity', requestedQuantity: null }],
    });
    expect(database.state.metadata.requestedPartySize).toBe(4);
  });

  it('aísla dos Tasks del mismo producto con resoluciones propias', async () => {
    database.state.metadata.pendingOrderLines = {
      lines: [
        { id: 'task-a', hint: 'Producto de prueba', requestedQuantity: 2, status: 'active', currentResolutionId: null },
        { id: 'task-b', hint: 'Producto de prueba', requestedQuantity: null, status: 'queued', currentResolutionId: null },
      ],
      sourceMessage: 'Dos líneas independientes del mismo producto',
      createdAt: new Date().toISOString(),
    };

    const searchA = JSON.parse(
      (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, CONFIG)) as string
    );
    const resolutionAId = searchA.items[0].resolutionId as string;
    const missingResolveTask = JSON.parse(
      (await resolveProductTool.func(
        { productId: PRODUCT_ID, resolutionId: resolutionAId },
        undefined,
        CONFIG
      )) as string
    );
    expect(missingResolveTask).toMatchObject({ success: false, error: 'order_line_id_required' });
    const resolutionA = JSON.parse(
      (await resolveProductTool.func(
        { productId: PRODUCT_ID, resolutionId: resolutionAId, orderLineId: 'task-a' },
        undefined,
        CONFIG
      )) as string
    );
    expect(resolutionA.success).toBe(true);

    // task-b sigue QUEUED: no puede recibir ProductResolution hasta continue_order_line.
    const ledgerBeforeQueued = structuredClone(database.state.metadata.productResolutions);
    const queuedResolve = JSON.parse(
      (await resolveProductTool.func(
        { productId: PRODUCT_ID, resolutionId: resolutionAId, orderLineId: 'task-b' },
        undefined,
        CONFIG
      )) as string
    );
    expect(queuedResolve).toMatchObject({ success: false, error: 'task_not_active' });
    expect(database.state.metadata.productResolutions).toEqual(ledgerBeforeQueued);
    expect(database.state.metadata.pendingOrderLines).toMatchObject({
      lines: [
        { id: 'task-a', status: 'active', currentResolutionId: resolutionAId },
        { id: 'task-b', status: 'queued', currentResolutionId: null },
      ],
    });

    const crossAddQueued = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, orderLineId: 'task-b', resolutionId: resolutionAId, quantity: 1 },
        undefined,
        CONFIG
      )) as string
    );
    expect(crossAddQueued).toMatchObject({ success: false, error: 'product_resolution_required' });
    expect(prisma.draft_order_item.create).not.toHaveBeenCalled();

    const missingTask = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, resolutionId: resolutionAId, quantity: 2 },
        undefined,
        CONFIG
      )) as string
    );
    expect(missingTask).toMatchObject({ success: false, error: 'order_line_id_required' });

    const missingResolution = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, orderLineId: 'task-b', quantity: 1 },
        undefined,
        CONFIG
      )) as string
    );
    expect(missingResolution).toMatchObject({ success: false, error: 'resolution_id_required' });

    const addA = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, orderLineId: 'task-a', resolutionId: resolutionAId, quantity: 2 },
        undefined,
        CONFIG
      )) as string
    );
    expect(addA.success).toBe(true);
    expect(database.state.metadata.productResolutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resolutionId: resolutionAId, status: 'consumed' }),
      ])
    );
    expect(database.state.metadata.pendingOrderLines).toMatchObject({
      lines: [
        { id: 'task-a', status: 'done', currentResolutionId: resolutionAId },
        { id: 'task-b', status: 'queued', currentResolutionId: null, requestedQuantity: null },
      ],
    });

    const continued = JSON.parse((await continueOrderLineToolForTests.func({}, undefined, CONFIG)) as string);
    expect(continued).toMatchObject({ success: true, effect: { kind: 'order_plan_advanced' } });

    // La resolución de task-a ya fue consumida: no se reutiliza para task-b.
    const sharedResolution = JSON.parse(
      (await resolveProductTool.func(
        { productId: PRODUCT_ID, resolutionId: resolutionAId, orderLineId: 'task-b' },
        undefined,
        CONFIG
      )) as string
    );
    expect(sharedResolution).toMatchObject({ success: false, error: 'product_resolution_required' });

    const searchB = JSON.parse(
      (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, CONFIG)) as string
    );
    const resolutionBId = searchB.items[0].resolutionId as string;
    const resolutionB = JSON.parse(
      (await resolveProductTool.func(
        { productId: PRODUCT_ID, resolutionId: resolutionBId, orderLineId: 'task-b' },
        undefined,
        CONFIG
      )) as string
    );

    expect(resolutionB.success).toBe(true);
    expect(resolutionAId).not.toBe(resolutionBId);
    expect(database.state.metadata.pendingOrderLines).toMatchObject({
      lines: [
        { id: 'task-a', currentResolutionId: resolutionAId, status: 'done' },
        { id: 'task-b', currentResolutionId: resolutionBId, status: 'active' },
      ],
    });

    const beforeCrossAdd = database.state.metadata.productResolutions;
    const crossAdd = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, orderLineId: 'task-b', resolutionId: resolutionAId, quantity: 1 },
        undefined,
        CONFIG
      )) as string
    );
    expect(crossAdd).toMatchObject({ success: false, error: 'product_resolution_required' });
    expect(database.state.metadata.productResolutions).toEqual(beforeCrossAdd);

    const reverseCrossAdd = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, orderLineId: 'task-a', resolutionId: resolutionBId, quantity: 1 },
        undefined,
        CONFIG
      )) as string
    );
    expect(reverseCrossAdd).toMatchObject({ success: false, error: 'product_resolution_required' });
    expect(database.state.metadata.productResolutions).toEqual(beforeCrossAdd);
    expect(prisma.draft_order_item.create).toHaveBeenCalledTimes(1);

    const quantityB = JSON.parse(
      (await setOrderLineQuantityTool.func(
        { orderLineId: 'task-b', quantity: 1 },
        undefined,
        {
          ...CONFIG,
          configurable: { ...CONFIG.configurable, userMessage: '1' },
        }
      )) as string
    );
    expect(quantityB).toMatchObject({
      success: true,
      orderLine: { id: 'task-b', requestedQuantity: 1 },
    });
    expect(database.state.metadata.pendingOrderLines).toMatchObject({
      lines: [
        { id: 'task-a', status: 'done', requestedQuantity: 2 },
        { id: 'task-b', status: 'active', requestedQuantity: 1, currentResolutionId: resolutionBId },
      ],
    });

    const addB = JSON.parse(
      (await addCartItemTool.func(
        { productId: PRODUCT_ID, orderLineId: 'task-b', resolutionId: resolutionBId, quantity: 1 },
        undefined,
        CONFIG
      )) as string
    );
    expect(addB).toMatchObject({ success: true, effect: { kind: 'cart_item_persisted' } });
    expect(database.state.metadata.productResolutions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resolutionId: resolutionAId, status: 'consumed' }),
        expect.objectContaining({ resolutionId: resolutionBId, status: 'consumed' }),
      ])
    );
    expect(database.state.metadata.pendingOrderLines).toBeUndefined();
    expect(prisma.draft_order_item.create).toHaveBeenCalledTimes(2);
  });

  describe('invariante ProductResolution → Task ACTIVE en resolve_product', () => {
    const seedTasks = (taskB: { status: string; currentResolutionId: string | null }) => {
      database.state.metadata.pendingOrderLines = {
        lines: [
          { id: 'task-a', hint: 'Producto de prueba', requestedQuantity: 2, status: 'active', currentResolutionId: null },
          { id: 'task-b', hint: 'Producto de prueba', requestedQuantity: null, ...taskB },
        ],
        sourceMessage: 'Producto de prueba y producto de prueba',
        createdAt: new Date().toISOString(),
      };
    };
    const taskLines = () =>
      (database.state.metadata.pendingOrderLines as { lines: Array<Record<string, unknown>> }).lines;
    const search = async () => JSON.parse(
      (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, CONFIG)) as string
    ).items[0].resolutionId as string;
    const resolve = async (orderLineId: string, resolutionId: string) => JSON.parse(
      (await resolveProductTool.func({ productId: PRODUCT_ID, resolutionId, orderLineId }, undefined, CONFIG)) as string
    );

    it('A — ACTIVE sin resolución: asocia la resolución a la Task', async () => {
      seedTasks({ status: 'queued', currentResolutionId: null });
      const resolutionId = await search();

      const result = await resolve('task-a', resolutionId);

      expect(result).toMatchObject({ success: true, orderLineId: 'task-a', currentResolutionId: resolutionId });
      expect(taskLines()[0]).toMatchObject({ status: 'active', currentResolutionId: resolutionId });
    });

    it('B — QUEUED sin resolución: task_not_active sin efectos', async () => {
      seedTasks({ status: 'queued', currentResolutionId: null });
      const resolutionId = await search();
      const before = structuredClone(database.state.metadata);

      const result = await resolve('task-b', resolutionId);

      expect(result).toMatchObject({ success: false, error: 'task_not_active' });
      expect(result.instruction).toMatch(/continue_order_line/);
      expect(result.instruction).not.toMatch(/Resolvé una ProductResolution nueva/);
      // Ni asociación ni selección/consumo en el ledger, ni cambios de status/cantidad.
      expect(database.state.metadata).toEqual(before);
      expect(taskLines()[1]).toMatchObject({
        status: 'queued',
        currentResolutionId: null,
        requestedQuantity: null,
      });
      expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    });

    it('C — ACTIVE con otra resolución: conserva task_already_associated (ownership intacto)', async () => {
      seedTasks({ status: 'queued', currentResolutionId: null });
      const first = await search();
      expect((await resolve('task-a', first)).success).toBe(true);
      const second = await search();

      const result = await resolve('task-a', second);

      expect(result).toMatchObject({
        success: false,
        error: 'task_resolution_association_rejected',
        reason: 'task_already_associated',
      });
      expect(taskLines()[0].currentResolutionId).toBe(first);
    });

    it('D — Task cerrada sigue respondiendo order_line_not_open', async () => {
      seedTasks({ status: 'done', currentResolutionId: null });
      const resolutionId = await search();

      expect(await resolve('task-b', resolutionId)).toEqual({ success: false, error: 'order_line_not_open' });
    });
  });

  describe('Quantity Goal → fulfillment en el mismo turno (PostEffectToolNode + tools reales)', () => {
    const lines = () =>
      (database.state.metadata.pendingOrderLines as { lines: Array<Record<string, unknown>> }).lines;
    const seedTwoLines = () => {
      database.state.metadata.pendingOrderLines = {
        lines: [
          { id: 'task-a', hint: 'Producto de prueba', requestedQuantity: null, status: 'active', currentResolutionId: null },
          { id: 'task-b', hint: 'Otro producto', requestedQuantity: null, status: 'queued', currentResolutionId: null },
        ],
        sourceMessage: 'Producto de prueba y otro producto',
        createdAt: new Date().toISOString(),
      };
    };
    const resolveTaskA = async () => {
      const search = JSON.parse(
        (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, CONFIG)) as string
      );
      const resolutionId = search.items[0].resolutionId as string;
      const resolved = JSON.parse(
        (await resolveProductTool.func({ productId: PRODUCT_ID, resolutionId, orderLineId: 'task-a' }, undefined, CONFIG)) as string
      );
      expect(resolved.success).toBe(true);
      return resolutionId;
    };
    const node = () => new PostEffectToolNode([setOrderLineQuantityTool, addCartItemTool]);
    const runCall = async (name: string, args: Record<string, unknown>, userMessage: string) => {
      const result = await node().invoke(
        { messages: [new AIMessage({ content: '', tool_calls: [{ id: `call-${name}`, name, args, type: 'tool_call' }] })] },
        { ...CONFIG, configurable: { ...CONFIG.configurable, userMessage } }
      );
      return JSON.parse(String((result.messages[0] as ToolMessage).content)) as Record<string, unknown>;
    };

    it('A — "Dame 2": cantidad persistida → nextRequiredTool add_cart_item → add → Task DONE y draft con 2', async () => {
      seedTwoLines();
      const resolutionId = await resolveTaskA();

      const persisted = await runCall('set_order_line_quantity', { orderLineId: 'task-a', quantity: 2 }, 'Dame 2');

      expect(persisted).toMatchObject({
        success: true,
        effect: { kind: 'order_line_quantity_persisted', reference: 'task-a' },
        nextRequiredTool: 'add_cart_item',
        nextRequiredToolArgs: { orderLineId: 'task-a', productId: PRODUCT_ID, resolutionId, quantity: 2 },
      });
      // set_order_line_quantity solo persiste: la Task sigue ACTIVE y no hay draft.
      expect(lines()[0]).toMatchObject({ status: 'active', requestedQuantity: 2, currentResolutionId: resolutionId });
      expect(prisma.draft_order_item.create).not.toHaveBeenCalled();

      const added = await runCall('add_cart_item', persisted.nextRequiredToolArgs as Record<string, unknown>, 'Dame 2');

      expect(added).toMatchObject({ success: true, effect: { kind: 'cart_item_persisted' }, added: { quantity: 2 } });
      expect(prisma.draft_order_item.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ quantity: 2 }) })
      );
      expect(lines()[0]).toMatchObject({ status: 'done', requestedQuantity: 2 });
      expect(lines()[1]).toMatchObject({ status: 'queued', currentResolutionId: null });
      expect(database.state.metadata.productResolutions).toEqual(
        expect.arrayContaining([expect.objectContaining({ resolutionId, status: 'consumed' })])
      );
    });

    it('TEST E — regresión real (3 líneas): al cerrar ceviche, queueFollowUp nombra papas (nunca chicha) y no se toca ninguna otra línea', async () => {
      database.state.metadata.pendingOrderLines = {
        lines: [
          { id: 'task-ceviche', hint: 'ceviche', requestedQuantity: null, status: 'active', currentResolutionId: null },
          { id: 'task-papas', hint: 'papas a la huancaína', requestedQuantity: null, status: 'queued', currentResolutionId: null },
          { id: 'task-chicha', hint: 'chicha morada', requestedQuantity: null, status: 'queued', currentResolutionId: null },
        ],
        sourceMessage: 'un ceviche, unas papas y una chicha',
        createdAt: new Date().toISOString(),
      };
      const search = JSON.parse(
        (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, CONFIG)) as string
      );
      const resolutionId = search.items[0].resolutionId as string;
      const resolved = JSON.parse(
        (await resolveProductTool.func({ productId: PRODUCT_ID, resolutionId, orderLineId: 'task-ceviche' }, undefined, CONFIG)) as string
      );
      expect(resolved.success).toBe(true);

      const persisted = await runCall('set_order_line_quantity', { orderLineId: 'task-ceviche', quantity: 2 }, 'Dame 2');
      expect(persisted.nextRequiredTool).toBe('add_cart_item');

      const added = await runCall('add_cart_item', persisted.nextRequiredToolArgs as Record<string, unknown>, 'Dame 2');

      expect(added).toMatchObject({
        success: true,
        closedOrderLine: { id: 'task-ceviche', status: 'done' },
        queueFollowUp: { nextHint: 'papas a la huancaína', remaining: 2 },
      });
      expect(JSON.stringify(added.queueFollowUp)).not.toContain('chicha');
      // Ningún efecto en las otras líneas: ni resueltas ni activadas por el solo cierre de ceviche.
      expect(lines()[1]).toMatchObject({ id: 'task-papas', status: 'queued', currentResolutionId: null });
      expect(lines()[2]).toMatchObject({ id: 'task-chicha', status: 'queued', currentResolutionId: null });
    });

    it('B — sin ProductResolution: la cantidad no se persiste y no hay nextRequiredTool', async () => {
      seedTwoLines();

      const result = await runCall('set_order_line_quantity', { orderLineId: 'task-a', quantity: 2 }, 'Dame 2');

      expect(result).toMatchObject({ success: false, error: 'product_resolution_required' });
      expect(result.nextRequiredTool).toBeUndefined();
      expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    });

    it('C — cantidad no confirmada por el mensaje: Goal sigue abierto y no hay nextRequiredTool', async () => {
      seedTwoLines();
      await resolveTaskA();

      const result = await runCall('set_order_line_quantity', { orderLineId: 'task-a', quantity: 2 }, 'Sí, seguí');

      expect(result).toMatchObject({ success: false, error: 'quantity_not_confirmed_by_user_message' });
      expect(result.nextRequiredTool).toBeUndefined();
      expect(lines()[0]).toMatchObject({ status: 'active', requestedQuantity: null });
    });

    it('D — ProductResolution vencida: fail closed, sin nextRequiredTool ni add', async () => {
      seedTwoLines();
      const resolutionId = await resolveTaskA();
      database.state.metadata.productResolutions = (
        database.state.metadata.productResolutions as Array<Record<string, unknown>>
      ).map((entry) => (entry.resolutionId === resolutionId
        ? { ...entry, expiresAt: new Date(Date.now() - 1_000).toISOString() }
        : entry));

      const result = await runCall('set_order_line_quantity', { orderLineId: 'task-a', quantity: 2 }, 'Dame 2');

      expect(result.success).toBe(false);
      expect(result.nextRequiredTool).toBeUndefined();
      expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    });

    it('E — Task QUEUED: la cantidad puede persistir pero nunca hay transición a add_cart_item', async () => {
      seedTwoLines();
      const resolutionId = await resolveTaskA();
      // Estado heredado (previo a la invariante ACTIVE): una QUEUED con resolución propia.
      lines()[0].status = 'queued';
      lines()[1].status = 'done';

      const result = await runCall('set_order_line_quantity', { orderLineId: 'task-a', quantity: 2 }, 'Dame 2');

      expect(result).toMatchObject({ success: true, effect: { kind: 'order_line_quantity_persisted' } });
      expect(result.nextRequiredTool).toBeUndefined();
      expect(lines()[0]).toMatchObject({ status: 'queued', currentResolutionId: resolutionId });
      expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    });

    it('F — resolución compartida con otra Task: sin transición y sin reasociar currentResolutionId', async () => {
      seedTwoLines();
      const resolutionId = await resolveTaskA();
      lines()[1].status = 'done';
      lines()[1].currentResolutionId = resolutionId;

      const result = await runCall('set_order_line_quantity', { orderLineId: 'task-a', quantity: 2 }, 'Dame 2');

      expect(result).toMatchObject({ success: true, effect: { kind: 'order_line_quantity_persisted' } });
      expect(result.nextRequiredTool).toBeUndefined();
      expect(lines()[0].currentResolutionId).toBe(resolutionId);
      expect(lines()[1].currentResolutionId).toBe(resolutionId);
      expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    });
  });

  describe('vigencia Task-bound, fin de turno y corrección de cantidad', () => {
    const lines = () =>
      (database.state.metadata.pendingOrderLines as { lines: Array<Record<string, unknown>> }).lines;
    const inTurn = (turnId: string, userMessage = 'Quiero 4 productos de prueba') => ({
      ...CONFIG,
      configurable: { ...CONFIG.configurable, turnId, userMessage },
    });
    const seed = () => {
      database.state.metadata.pendingOrderLines = {
        lines: [
          { id: 'task-a', hint: 'Producto de prueba', requestedQuantity: null, status: 'active', currentResolutionId: null },
          { id: 'task-b', hint: 'Otro producto', requestedQuantity: null, status: 'queued', currentResolutionId: null },
        ],
        sourceMessage: 'Producto de prueba y otro producto',
        createdAt: new Date().toISOString(),
      };
    };
    // search_products con un único match emite una resolución scope "turn".
    const resolveInTurn = async (turnId: string, orderLineId = 'task-a') => {
      const search = JSON.parse(
        (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, inTurn(turnId))) as string
      );
      const resolutionId = search.items[0].resolutionId as string;
      const resolved = JSON.parse(
        (await resolveProductTool.func({ productId: PRODUCT_ID, resolutionId, orderLineId }, undefined, inTurn(turnId))) as string
      );
      return { resolutionId, resolved };
    };
    const ledgerEntry = (resolutionId: string) =>
      (database.state.metadata.productResolutions as Array<Record<string, unknown>>)
        .find((entry) => entry.resolutionId === resolutionId);
    const add = async (args: Record<string, unknown>, turnId: string) => JSON.parse(
      (await addCartItemTool.func(args as never, undefined, inTurn(turnId))) as string
    );

    it('TEST 1 — resolución scope "turn" asociada a la Task sobrevive al cambio de turno y se consume', async () => {
      seed();
      const { resolutionId, resolved } = await resolveInTurn('turn-5');
      expect(resolved.success).toBe(true);
      expect(ledgerEntry(resolutionId)).toMatchObject({ scope: 'turn', turnId: 'turn-5', status: 'selected' });
      lines()[0].requestedQuantity = 3;

      const result = await add({ productId: PRODUCT_ID, orderLineId: 'task-a', resolutionId }, 'turn-7');

      expect(result).toMatchObject({ success: true, effect: { kind: 'cart_item_persisted' }, added: { quantity: 3 } });
      expect(prisma.draft_order_item.create).toHaveBeenCalledOnce();
      expect(ledgerEntry(resolutionId)).toMatchObject({ status: 'consumed' });
      expect(lines()[0]).toMatchObject({ status: 'done' });
    });

    it('TEST 2 — la resolución de la Task A no la puede usar otra Task ni se reasocia', async () => {
      seed();
      const { resolutionId } = await resolveInTurn('turn-5');
      lines()[1].requestedQuantity = 1;

      const result = await add({ productId: PRODUCT_ID, orderLineId: 'task-b', resolutionId }, 'turn-7');

      expect(result).toMatchObject({ success: false, error: 'product_resolution_required' });
      expect(lines()[0].currentResolutionId).toBe(resolutionId);
      expect(lines()[1].currentResolutionId).toBeNull();
      expect(ledgerEntry(resolutionId)).toMatchObject({ status: 'selected' });
      expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    });

    it('TEST 3 — una resolución scope "turn" sin Task sigue venciendo en el turno siguiente', async () => {
      const search = JSON.parse(
        (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, inTurn('turn-5'))) as string
      );
      const resolutionId = search.items[0].resolutionId as string;
      expect(ledgerEntry(resolutionId)).toMatchObject({ scope: 'turn', turnId: 'turn-5' });

      const result = await add({ productId: PRODUCT_ID, resolutionId, quantity: 1 }, 'turn-7');

      expect(result).toMatchObject({ success: false, error: 'product_resolution_required' });
      expect(prisma.draft_order_item.create).not.toHaveBeenCalled();
    });

    it.each([
      ['scope turn de un turno anterior (asociada)', (entry: Record<string, unknown>) => entry],
      ['vencida por TTL', (entry: Record<string, unknown>) => ({ ...entry, expiresAt: new Date(Date.now() - 1_000).toISOString() })],
      ['consumida', (entry: Record<string, unknown>) => ({ ...entry, status: 'consumed' })],
      ['scope pending sin entrada pendiente', (entry: Record<string, unknown>) => ({ ...entry, scope: 'pending' })],
    ])('TEST 4 — getFulfillmentReadyOrderLine coincide con lo que acepta add_cart_item: %s', async (_label, mutate) => {
      seed();
      const { resolutionId } = await resolveInTurn('turn-5');
      lines()[0].requestedQuantity = 2;
      database.state.metadata.productResolutions = (
        database.state.metadata.productResolutions as Array<Record<string, unknown>>
      ).map((entry) => (entry.resolutionId === resolutionId ? mutate(entry) : entry));

      const line = getPendingOrderLines(database.state.metadata)!.lines[0];
      const ready = getFulfillmentReadyOrderLine(line, database.state.metadata, {
        businessId: BUSINESS_ID,
        conversationId: CONVERSATION_ID,
      });
      const result = await add({ productId: PRODUCT_ID, orderLineId: 'task-a', resolutionId }, 'turn-7');

      expect(ready != null).toBe(result.success === true);
    });

    it('TEST 6/7 — el add cierra solo la Task A (señal de fin de turno) y B se activa recién con continue_order_line', async () => {
      seed();
      const { resolutionId } = await resolveInTurn('turn-4');
      lines()[0].requestedQuantity = 2;

      const result = await add({ productId: PRODUCT_ID, orderLineId: 'task-a', resolutionId }, 'turn-4');

      expect(result).toMatchObject({ success: true, closedOrderLine: { id: 'task-a', status: 'done' } });
      expect(completesTask(result)).toBe(true);
      expect(lines()[0]).toMatchObject({ status: 'done' });
      expect(lines()[1]).toMatchObject({ status: 'queued', currentResolutionId: null });

      const continued = JSON.parse(
        (await continueOrderLineToolForTests.func({}, undefined, inTurn('turn-5', 'Sí, seguí'))) as string
      );
      expect(continued).toMatchObject({ success: true, effect: { kind: 'order_plan_advanced' } });
      expect(lines()[1]).toMatchObject({ status: 'active' });
    });

    it('CASO B — resolve_product con una resolución nueva sobre una Task ya asociada devuelve la recuperación canónica', async () => {
      seed();
      const { resolutionId: r1 } = await resolveInTurn('turn-5');
      const search = JSON.parse(
        (await searchProductsTool.func({ keyword: 'producto de prueba' }, undefined, inTurn('turn-6'))) as string
      );
      const r2 = search.items[0].resolutionId as string;

      const result = JSON.parse(
        (await resolveProductTool.func({ productId: PRODUCT_ID, resolutionId: r2, orderLineId: 'task-a' }, undefined, inTurn('turn-6'))) as string
      );

      expect(result).toMatchObject({
        success: false,
        reason: 'task_already_associated',
        nextRequiredTool: 'add_cart_item',
        nextRequiredToolArgs: { orderLineId: 'task-a', productId: PRODUCT_ID, resolutionId: r1 },
      });
      expect((result.nextRequiredToolArgs as { resolutionId: string }).resolutionId === r1).toBe(true);
      expect(lines()[0].currentResolutionId).toBe(r1);
    });

    it('TEST 8 — "Mejor 3" corrige una cantidad ya persistida', async () => {
      seed();
      await resolveInTurn('turn-4');
      lines()[0].requestedQuantity = 2;

      const result = JSON.parse(
        (await setOrderLineQuantityTool.func({ orderLineId: 'task-a', quantity: 3 }, undefined, inTurn('turn-5', 'Mejor 3'))) as string
      );

      expect(result).toMatchObject({ success: true, orderLine: { id: 'task-a', requestedQuantity: 3 } });
      expect(lines()[0].requestedQuantity).toBe(3);
    });

    it('TEST 10 — sin respaldo del mensaje ("Perfecto") la cantidad persistida no cambia', async () => {
      seed();
      await resolveInTurn('turn-4');
      lines()[0].requestedQuantity = 2;

      const result = JSON.parse(
        (await setOrderLineQuantityTool.func({ orderLineId: 'task-a', quantity: 5 }, undefined, inTurn('turn-5', 'Perfecto'))) as string
      );

      expect(result).toMatchObject({ success: false, error: 'quantity_not_confirmed_by_user_message' });
      expect(lines()[0].requestedQuantity).toBe(2);
    });
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