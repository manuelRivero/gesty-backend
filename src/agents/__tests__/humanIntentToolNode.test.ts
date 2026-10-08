import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const {
  getStateMock,
  itemFindFirstMock,
  categoryFindFirstMock,
  conversationStateFindUniqueMock,
  findOrCreateConversationStateMock,
  patchConversationMetadataMock,
  reconcileAfterToolMock,
  resolveProductForAddMock,
} = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  itemFindFirstMock: vi.fn(),
  categoryFindFirstMock: vi.fn(),
  conversationStateFindUniqueMock: vi.fn(),
  findOrCreateConversationStateMock: vi.fn(),
  patchConversationMetadataMock: vi.fn(),
  reconcileAfterToolMock: vi.fn(),
  resolveProductForAddMock: vi.fn(),
}));

vi.mock('../../services/humanIntentState.service', () => ({
  getHumanIntentState: getStateMock,
}));

vi.mock('../../services/humanIntentReconciliation.service', () => ({
  reconcileHumanIntentAfterToolEffect: reconcileAfterToolMock,
}));

vi.mock('../../services/productResolution.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/productResolution.service')>()),
  resolveProductForAdd: resolveProductForAddMock,
}));

vi.mock('../../repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../repositories')>();
  return {
    ...actual,
    findOrCreateConversationState: (...args: unknown[]) =>
      findOrCreateConversationStateMock(...args),
    patchConversationMetadata: (...args: unknown[]) =>
      patchConversationMetadataMock(...args),
  };
});

vi.mock('../../lib/prisma', () => ({
  prisma: {
    menu_item: { findFirst: itemFindFirstMock, findMany: vi.fn() },
    menu_category: { findFirst: categoryFindFirstMock },
    conversation_state: { findUnique: conversationStateFindUniqueMock },
  },
}));

import { ToolPlanner } from '../toolPlanner';
import { findDeclaredProducer, PRODUCT_CANDIDATE, PRODUCT_RESOLUTION } from '../toolContracts';
import { collectRequestTargets, isFailClosedTaskRejection } from '../humanIntentToolNode';
import {
  HUMAN_INTENT_STATE_STALE,
  HUMAN_INTENT_TOOL_DENIED,
  HumanIntentToolNode,
} from '../humanIntentToolNode';

const ACTIVE = {
  id: 'intent-order',
  sequence: 1,
  goal: 'PEDIR',
  request: { products: ['ceviche'] },
  status: 'ACTIVE',
  blockers: [],
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};

const PENDING = {
  id: 'intent-dessert',
  sequence: 2,
  goal: 'EXPLORAR',
  request: { category: 'postres' },
  status: 'PENDING',
  blockers: [],
  createdAt: '2026-09-27T00:00:00.000Z',
  updatedAt: '2026-09-27T00:00:00.000Z',
};
const PRODUCT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_PRODUCT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const state = (records: Array<Record<string, unknown>> = [ACTIVE, PENDING], revision = 7) => ({
  version: 1 as const,
  revision,
  nextSequence: records.length + 1,
  processedMessageIds: ['wamid-turn'],
  records,
});


const toolCall = (name: string, args: Record<string, unknown>) =>
  toolCalls([{ name, args, id: `call-${name}` }]);

const toolCalls = (calls: Array<{ name: string; args: Record<string, unknown>; id: string }>) =>
  new AIMessage({
    content: '',
    tool_calls: calls.map(({ id, name, args }) => ({ id, name, args, type: 'tool_call' })),
  });

const makeTool = (name: string, effect: () => unknown) =>
  new DynamicStructuredTool({
    name,
    description: 'test tool',
    schema: z.object({
      keyword: z.string().optional(),
      categoryId: z.string().optional(),
    }),
    func: async () => {
      await effect();
      return JSON.stringify({ success: true });
    },
  });

const makeAddCartItemTool = (effect: (config?: { configurable?: Record<string, unknown> }) => unknown) =>
  new DynamicStructuredTool({
    name: 'add_cart_item',
    description: 'test tool',
    schema: z.object({ productId: z.string().uuid() }),
    func: async (_args, _runManager, config) => {
      await effect(config);
      return JSON.stringify({
        success: true,
        effect: { kind: 'cart_item_persisted', reference: PRODUCT_ID },
      });
    },
  });

const makeResolveProductTool = (effect: () => unknown, success = true) =>
  new DynamicStructuredTool({
    name: 'resolve_product',
    description: 'resolve product',
    schema: z.object({ productId: z.string().uuid(), resolutionId: z.string() }),
    func: async (args) => {
      await effect();
      return JSON.stringify({
        success,
        resolutionId: args.resolutionId,
        productId: args.productId,
        businessId: 'biz-1',
        conversationId: 'conv-1',
        source: 'search_products',
        status: 'selected',
        scope: 'conversation',
        createdAt: '2026-09-29T00:00:00.000Z',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    },
  });

const config = (revision = 7, configurableOverrides: Record<string, unknown> = {}) => ({
  configurable: {
    conversationId: 'conv-1',
    customerPhone: '+5491100000000',
    businessId: 'biz-1',
    humanIntentGateRevision: revision,
    ...configurableOverrides,
  },
});

describe('HumanIntentToolNode', () => {
  let persistedConversationMetadata: Record<string, unknown>;

  beforeEach(() => {
    vi.clearAllMocks();
    persistedConversationMetadata = { peopleCount: 2 };
    getStateMock.mockResolvedValue(state());
    reconcileAfterToolMock.mockResolvedValue(null);
    resolveProductForAddMock.mockResolvedValue({ ok: false, reason: 'resolution_missing' });
    findOrCreateConversationStateMock.mockImplementation(async () => ({
      metadata: persistedConversationMetadata,
    }));
    patchConversationMetadataMock.mockImplementation(
      async (_conversationId: string, patch: Record<string, unknown>) => {
        persistedConversationMetadata = { ...persistedConversationMetadata, ...patch };
      }
    );
    conversationStateFindUniqueMock.mockResolvedValue({ metadata: { peopleCount: 2 } });
    itemFindFirstMock.mockResolvedValue({ name: 'Ceviche Clásico' });
    categoryFindFirstMock.mockResolvedValue({ name: 'Postres' });
  });

  it('rechaza un target quantity cruzado y termina el ciclo sin ejecutar otras tools', async () => {
    const quantityEffect = vi.fn();
    const addEffect = vi.fn();
    const resolveEffect = vi.fn();
    const node = new HumanIntentToolNode([
      makeTool('set_order_line_quantity', quantityEffect),
      makeAddCartItemTool(addEffect),
      makeResolveProductTool(resolveEffect),
    ]);
    const result = await node.invoke({
      messages: [toolCalls([
        { id: 'quantity-a', name: 'set_order_line_quantity', args: { orderLineId: 'line-a', quantity: 2 } },
        { id: 'add-crossed', name: 'add_cart_item', args: { productId: PRODUCT_ID, orderLineId: 'line-a' } },
        { id: 'resolve-crossed', name: 'resolve_product', args: { productId: PRODUCT_ID, resolutionId: 'R' } },
      ])],
    }, config(7, {
      activeBlockingGoal: 'OBTENER_CANTIDAD_DEL_PRODUCTO',
      goalFulfillmentCandidate: {
        goalType: 'OBTENER_CANTIDAD_DEL_PRODUCTO',
        target: { orderLineId: 'line-b', hint: 'papas' },
      },
    }));

    const toolMessages = result.messages.filter(ToolMessage.isInstance) as ToolMessage[];
    expect(toolMessages).toHaveLength(3);
    expect(JSON.parse(String(toolMessages[0].content))).toMatchObject({
      success: false,
      error: 'goal_target_mismatch',
      expectedOrderLineId: 'line-b',
      receivedOrderLineId: 'line-a',
    });
    expect(toolMessages.map((message) => message.tool_call_id)).toEqual([
      'quantity-a', 'add-crossed', 'resolve-crossed',
    ]);
    expect(quantityEffect).not.toHaveBeenCalled();
    expect(addEffect).not.toHaveBeenCalled();
    expect(resolveEffect).not.toHaveBeenCalled();
    expect(result.messages.at(-1)).toBeInstanceOf(AIMessage);
    expect(String(result.messages.at(-1)?.content)).toContain('papas');
  });

  it('permite ejecutar una tool cuyo target coincide con ACTIVE', async () => {
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeTool('search_products', effect)]);

    const result = await node.invoke({ messages: [toolCall('search_products', { keyword: 'ceviche' })] }, config());

    expect(effect).toHaveBeenCalledOnce();
    expect(result.messages[0]).toMatchObject({ status: 'success' });
    expect(reconcileAfterToolMock).not.toHaveBeenCalled();
  });

  it('reconcilia después de ejecutar una tool autorizada y exitosa', async () => {
    const resolveEffect = vi.fn();
    const node = new HumanIntentToolNode([
      makeTool('search_products', vi.fn()),
      makeResolveProductTool(resolveEffect),
      makeAddCartItemTool(vi.fn()),
    ]);

    await node.invoke(
      { messages: [toolCalls([
        { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
        { id: 'resolve-1', name: 'resolve_product', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
        { id: 'add-1', name: 'add_cart_item', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
      ])] },
      config()
    );

    expect(reconcileAfterToolMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', businessId: 'biz-1' })
    );
    expect(reconcileAfterToolMock.mock.calls[0][0].effect).toMatchObject({
      kind: 'cart_item_persisted',
      reference: PRODUCT_ID,
      success: true,
    });
    expect(resolveEffect).toHaveBeenCalledOnce();
  });

  it('encamina el batch real search → resolve → add por el ToolPlanner', async () => {
    const planSpy = vi.spyOn(ToolPlanner.prototype, 'plan');
    const executionOrder: string[] = [];
    const searchEffect = vi.fn(() => executionOrder.push('search_products'));
    const resolveEffect = vi.fn(() => executionOrder.push('resolve_product'));
    const addEffect = vi.fn(() => executionOrder.push('add_cart_item'));
    const node = new HumanIntentToolNode([
      makeTool('search_products', searchEffect),
      makeResolveProductTool(resolveEffect, true),
      makeAddCartItemTool(addEffect),
    ]);

    resolveProductForAddMock.mockResolvedValue({
      ok: true,
      resolution: { productId: PRODUCT_ID, resolutionId: 'resolution-1' },
    });

    const result = await node.invoke(
      {
        messages: [toolCalls([
          { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
          {
            id: 'resolve-1',
            name: 'resolve_product',
            args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' },
          },
          {
            id: 'add-1',
            name: 'add_cart_item',
            args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' },
          },
        ])],
      },
      config()
    );

    expect(planSpy).toHaveBeenCalled();
    expect(planSpy.mock.calls[0][0]).toHaveLength(3);
    expect(searchEffect).toHaveBeenCalledOnce();
    expect(resolveEffect).toHaveBeenCalledOnce();
    expect(addEffect).toHaveBeenCalledOnce();
    expect(executionOrder).toEqual(['search_products', 'resolve_product', 'add_cart_item']);
    expect(result.messages).toHaveLength(3);
    expect(result.messages.map((message) => (message as ToolMessage).tool_call_id)).toEqual([
      'search-1',
      'resolve-1',
      'add-1',
    ]);
  });

  it('revalida add después de resolve y difiere si requestedQuantity sigue UNKNOWN', async () => {
    const resolutionId = 'pr1:biz-1:conv-1:resolution-unknown-quantity';
    const productResolution = {
      resolutionId,
      productId: PRODUCT_ID,
      businessId: 'biz-1',
      conversationId: 'conv-1',
      source: 'search_products',
      status: 'candidate',
      scope: 'conversation',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    persistedConversationMetadata = {
      peopleCount: 4,
      requestedPartySize: 4,
      pendingOrderLines: {
        sourceMessage: 'ceviche',
        createdAt: new Date().toISOString(),
        lines: [{
          id: 'line-ceviche',
          hint: 'ceviche',
          requestedQuantity: null,
          status: 'active',
          currentResolutionId: null,
        }],
      },
      productResolutions: [productResolution],
    };
    conversationStateFindUniqueMock.mockImplementation(async () => ({
      metadata: persistedConversationMetadata,
    }));
    const addEffect = vi.fn();
    const resolveEffect = vi.fn(() => {
      const metadata = persistedConversationMetadata;
      const pendingOrderLines = metadata.pendingOrderLines as {
        lines: Array<Record<string, unknown>>;
      };
      persistedConversationMetadata = {
        ...metadata,
        pendingOrderLines: {
          ...pendingOrderLines,
          lines: pendingOrderLines.lines.map((line) =>
            line.id === 'line-ceviche' ? { ...line, currentResolutionId: resolutionId } : line
          ),
        },
        productResolutions: [{ ...productResolution, status: 'selected' }],
      };
    });
    const node = new HumanIntentToolNode([
      makeResolveProductTool(resolveEffect, true),
      makeAddCartItemTool(addEffect),
    ]);

    const result = await node.invoke(
      {
        messages: [toolCalls([
          {
            id: 'resolve-1',
            name: 'resolve_product',
            args: { productId: PRODUCT_ID, resolutionId, orderLineId: 'line-ceviche' },
          },
          {
            id: 'add-1',
            name: 'add_cart_item',
            args: { productId: PRODUCT_ID, resolutionId, orderLineId: 'line-ceviche', quantity: 3 },
          },
        ])],
      },
      config()
    );

    expect(resolveEffect).toHaveBeenCalledOnce();
    expect((persistedConversationMetadata.pendingOrderLines as { lines: Array<Record<string, unknown>> }).lines[0])
      .toMatchObject({ currentResolutionId: resolutionId, requestedQuantity: null });
    expect(addEffect).not.toHaveBeenCalled();
    const addResult = result.messages[1] as ToolMessage;
    expect(addResult.tool_call_id).toBe('add-1');
    expect(JSON.parse(String(addResult.content))).toMatchObject({
      success: false,
      error: 'order_line_quantity_required',
      missingRequirements: ['ORDER_LINE_QUANTITY_PERSISTED'],
      askMessage: expect.stringMatching(/ceviche/i),
    });
  });

  it('usa runTool para add aislado y acepta una ProductResolution persistida', async () => {
    const planSpy = vi.spyOn(ToolPlanner.prototype, 'plan');
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeAddCartItemTool(effect)]);
    resolveProductForAddMock.mockResolvedValue({
      ok: true,
      resolution: { productId: PRODUCT_ID, resolutionId: 'persisted-resolution' },
    });

    const result = await node.invoke(
      {
        messages: [toolCalls([
          { id: 'call-123', name: 'add_cart_item', args: { productId: PRODUCT_ID } },
        ])],
      },
      config()
    );

    expect(planSpy).not.toHaveBeenCalled();
    expect(resolveProductForAddMock).toHaveBeenCalledWith(expect.objectContaining({
      productId: PRODUCT_ID,
      businessId: 'biz-1',
      conversationId: 'conv-1',
    }));
    expect(effect).toHaveBeenCalledOnce();
    expect((result.messages[0] as ToolMessage).tool_call_id).toBe('call-123');
  });

  it('responde un add aislado bloqueado con el ID original y sin Planner', async () => {
    const planSpy = vi.spyOn(ToolPlanner.prototype, 'plan');
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeAddCartItemTool(effect)]);

    const result = await node.invoke(
      {
        messages: [toolCalls([
          { id: 'call-123', name: 'add_cart_item', args: { productId: PRODUCT_ID } },
        ])],
      },
      config()
    );

    const message = result.messages[0] as ToolMessage;
    expect(planSpy).not.toHaveBeenCalled();
    expect(resolveProductForAddMock).toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
    expect(message.tool_call_id).toBe('call-123');
    expect(message.tool_call_id).not.toBe('add_cart_item');
    expect(message.status).toBe('success');
    expect(JSON.parse(String(message.content))).toMatchObject({
      success: false,
      error: 'product_resolution_required',
    });
  });

  it('mantiene el ID LLM al emitir un resultado BLOCKED de ToolExecutor', async () => {
    const node = new HumanIntentToolNode([
      makeTool('search_products', vi.fn()),
      makeResolveProductTool(vi.fn(), true),
      makeAddCartItemTool(vi.fn()),
    ]);

    const result = await node.invoke(
      {
        messages: [toolCalls([
          { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
          {
            id: 'resolve-1',
            name: 'resolve_product',
            args: { productId: PRODUCT_ID, resolutionId: 'resolution-a' },
          },
          {
            id: 'add-2',
            name: 'add_cart_item',
            args: { productId: OTHER_PRODUCT_ID, resolutionId: 'resolution-b' },
          },
        ])],
      },
      config()
    );

    const blocked = result.messages.find(
      (message) => ToolMessage.isInstance(message) && message.tool_call_id === 'add-2'
    ) as ToolMessage | undefined;
    expect(blocked).toBeDefined();
    expect(blocked?.tool_call_id).toBe('add-2');
    expect(blocked?.tool_call_id).not.toBe('add_cart_item');
    expect(JSON.parse(String(blocked?.content))).toMatchObject({
      success: false,
      error: 'missing_producer_or_requirement',
    });
  });

  it('mantiene el ID LLM al emitir un resultado REJECTED de ToolExecutor', async () => {
    getStateMock.mockResolvedValue(state([
      { ...ACTIVE, goal: 'EXPLORAR', request: { category: 'postres' } },
    ]));
    const node = new HumanIntentToolNode([
      makeTool('search_products', vi.fn()),
      makeResolveProductTool(vi.fn(), true),
      makeAddCartItemTool(vi.fn()),
    ]);

    const result = await node.invoke(
      {
        messages: [toolCalls([
          { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
          {
            id: 'resolve-1',
            name: 'resolve_product',
            args: { productId: PRODUCT_ID, resolutionId: 'resolution-a' },
          },
          {
            id: 'add-3',
            name: 'add_cart_item',
            args: { productId: PRODUCT_ID, resolutionId: 'resolution-a' },
          },
        ])],
      },
      config()
    );

    const rejected = result.messages.find(
      (message) => ToolMessage.isInstance(message) && message.tool_call_id === 'add-3'
    ) as ToolMessage | undefined;
    expect(rejected).toBeDefined();
    expect(rejected?.tool_call_id).toBe('add-3');
    expect(rejected?.tool_call_id).not.toBe('add_cart_item');
    expect(JSON.parse(String(rejected?.content))).toMatchObject({
      success: false,
      error: 'human_intent_incompatible',
    });
  });

  it('difiere el ADD sin party size aunque ProductResolution sea válida', async () => {
    conversationStateFindUniqueMock.mockResolvedValue({ metadata: {} });
    const effect = vi.fn();
    const node = new HumanIntentToolNode([
      makeTool('search_products', vi.fn()),
      makeResolveProductTool(vi.fn()),
      makeAddCartItemTool(effect),
    ]);

    const result = await node.invoke(
      { messages: [toolCalls([
        { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
        { id: 'resolve-1', name: 'resolve_product', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
        { id: 'add-1', name: 'add_cart_item', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
      ])] },
      config()
    );

    expect(effect).not.toHaveBeenCalled();
    expect((result.messages[2] as ToolMessage).tool_call_id).toBe('add-1');
    expect(JSON.parse(String(result.messages[2].content))).toMatchObject({
      success: false,
      error: 'party_size_required',
      missingRequirements: ['PARTY_SIZE_OBTAINED'],
    });
  });

  it('usa el mismo hook para otros efectos persistidos declarados', async () => {
    const partySizeTool = new DynamicStructuredTool({
      name: 'save_party_size',
      description: 'persist party size',
      schema: z.object({}),
      func: async () =>
        JSON.stringify({ success: true, effect: { kind: 'party_size_persisted' } }),
    });
    const node = new HumanIntentToolNode([partySizeTool]);

    await node.invoke(
      { messages: [toolCall('save_party_size', {})] },
      config()
    );

    expect(reconcileAfterToolMock.mock.calls[0][0].effect).toMatchObject({
      kind: 'party_size_persisted',
      success: true,
    });
    expect(reconcileAfterToolMock.mock.calls[0][0].effect.reference).toBeUndefined();
  });

  it('bloquea una tool cuyo target coincide solo con PENDING', async () => {
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeTool('present_category', effect)]);

    const result = await node.invoke(
      { messages: [toolCall('present_category', { categoryId: 'category-desserts' })] },
      config()
    );
    const message = result.messages[0] as ToolMessage;

    expect(effect).not.toHaveBeenCalled();
    expect(message.status).toBe('error');
    expect(JSON.parse(String(message.content))).toMatchObject({
      error: HUMAN_INTENT_TOOL_DENIED,
      pendingIntentId: PENDING.id,
    });
  });

  it('no consulta Prisma ni persiste un ADD sin UUID ni ProductResolution', async () => {
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeAddCartItemTool(effect)]);

    const result = await node.invoke(
      { messages: [toolCall('add_cart_item', { productId: 'ceviche' })] },
      config()
    );
    const message = result.messages[0] as ToolMessage;

    expect(itemFindFirstMock).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
    expect(message.status).toBe('error');
    expect(message.tool_call_id).toBe('call-add_cart_item');
    expect(String(message.content)).not.toContain('invalid input syntax for type uuid');
  });

  it('conserva la autorización del gate para un productId UUID válido', async () => {
    getStateMock.mockResolvedValue(
      state([
        { ...ACTIVE, request: { products: ['lomo'] } },
        { ...PENDING, request: { products: ['ceviche'] } },
      ])
    );
    const effect = vi.fn();
    const node = new HumanIntentToolNode([
      makeTool('search_products', vi.fn()),
      makeResolveProductTool(vi.fn()),
      makeAddCartItemTool(effect),
    ]);

    const result = await node.invoke(
      { messages: [toolCalls([
        { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
        { id: 'resolve-1', name: 'resolve_product', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
        { id: 'add-1', name: 'add_cart_item', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
      ])] },
      config()
    );
    const message = result.messages[2] as ToolMessage;

    expect(itemFindFirstMock).toHaveBeenCalledWith({
      where: { id: PRODUCT_ID, business_id: 'biz-1' },
      select: { name: true },
    });
    expect(effect).not.toHaveBeenCalled();
    expect(message.status).toBe('error');
    expect(JSON.parse(String(message.content))).toMatchObject({
      error: HUMAN_INTENT_TOOL_DENIED,
      pendingIntentId: PENDING.id,
    });
  });

  it('permite una tool neutral', async () => {
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeTool('get_cart', effect)]);

    const result = await node.invoke({ messages: [toolCall('get_cart', {})] }, config());

    expect(effect).toHaveBeenCalledOnce();
    expect(result.messages[0]).toMatchObject({ status: 'success' });
  });

  it('la denegación no modifica ACTIVE, PENDING ni revision', async () => {
    const original = state();
    getStateMock.mockResolvedValue(original);
    const before = structuredClone(original);
    const node = new HumanIntentToolNode([makeTool('present_category', vi.fn())]);

    await node.invoke(
      { messages: [toolCall('present_category', { categoryId: 'category-desserts' })] },
      config()
    );

    expect(original).toEqual(before);
  });

  it('el error de autorización es ToolMessage interno, no respuesta al usuario', async () => {
    const node = new HumanIntentToolNode([makeTool('present_category', vi.fn())]);

    const result = await node.invoke(
      { messages: [toolCall('present_category', { categoryId: 'category-desserts' })] },
      config()
    );

    expect(result.messages).toHaveLength(1);
    expect(ToolMessage.isInstance(result.messages[0])).toBe(true);
    expect(result.messages[0].tool_call_id).toBe('call-present_category');
  });

  it('sin ACTIVE conserva la ejecución legacy', async () => {
    getStateMock.mockResolvedValue(state([], 7));
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeTool('present_category', effect)]);

    await node.invoke(
      { messages: [toolCall('present_category', { categoryId: 'category-desserts' })] },
      config()
    );

    expect(effect).toHaveBeenCalledOnce();
  });

  it('revision obsoleta bloquea antes de ejecutar la implementación', async () => {
    getStateMock.mockResolvedValue(state([ACTIVE, PENDING], 8));
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeTool('search_products', effect)]);

    const result = await node.invoke(
      { messages: [toolCall('search_products', { keyword: 'ceviche' })] },
      config(7)
    );

    expect(effect).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.messages[0].content))).toMatchObject({
      error: HUMAN_INTENT_STATE_STALE,
    });
  });

  it('mantiene en paralelo búsquedas independientes del mismo batch', async () => {
    let started = 0;
    let releaseSearches!: () => void;
    const searchesReleased = new Promise<void>((resolve) => {
      releaseSearches = resolve;
    });
    const searchEffect = vi.fn(async () => {
      started += 1;
      if (started === 2) releaseSearches();
      await searchesReleased;
    });
    const node = new HumanIntentToolNode([
      makeTool('search_products', searchEffect),
      makeAddCartItemTool(vi.fn()),
    ]);

    const result = await node.invoke(
      {
        messages: [toolCalls([
          { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
          { id: 'search-2', name: 'search_products', args: { keyword: 'lomo' } },
          { id: 'add-1', name: 'add_cart_item', args: { productId: PRODUCT_ID } },
        ])],
      },
      config()
    );

    expect(searchEffect).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(result.messages[2].content))).toMatchObject({
      success: false,
      error: 'product_resolution_required',
    });
  });

  it('ejecuta search, resolve y add en orden sin resolver dos veces', async () => {
    resolveProductForAddMock.mockResolvedValue({ ok: true, resolution: { productId: PRODUCT_ID } });
    const events: string[] = [];
    const resolutionsAtAdd: unknown[] = [];
    const node = new HumanIntentToolNode([
      makeTool('search_products', () => { events.push('search'); }),
      makeResolveProductTool(() => { events.push('resolve'); }),
      makeAddCartItemTool((toolConfig) => {
        events.push('add');
        resolutionsAtAdd.push(toolConfig?.configurable?.validatedProductResolutionFromExecutionContext);
      }),
    ]);

    await node.invoke(
      {
        messages: [toolCalls([
          { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
          {
            id: 'add-1',
            name: 'add_cart_item',
            args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' },
          },
          {
            id: 'resolve-1',
            name: 'resolve_product',
            args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' },
          },
        ])],
      },
      config()
    );

    expect(events).toEqual(['search', 'resolve', 'add']);
    expect(resolutionsAtAdd).toEqual([
      expect.objectContaining({
        productId: PRODUCT_ID,
        resolutionId: 'resolution-1',
        businessId: 'biz-1',
        conversationId: 'conv-1',
        status: 'selected',
      }),
    ]);
    expect(resolveProductForAddMock).not.toHaveBeenCalled();
    expect(reconcileAfterToolMock).toHaveBeenCalledTimes(1);
  });

  it('espera la búsqueda antes de resolver productos del mismo batch', async () => {
    const events: string[] = [];
    const node = new HumanIntentToolNode([
      makeTool('search_products', () => { events.push('search'); }),
      makeResolveProductTool(() => { events.push('resolve'); }),
    ]);

    await node.invoke(
      {
        messages: [toolCalls([
          { id: 'resolve-1', name: 'resolve_product', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
          { id: 'search-1', name: 'search_products', args: { keyword: 'producto' } },
        ])],
      },
      config()
    );

    expect(events).toEqual(['search', 'resolve']);
  });

  it('no invoca add_cart_item cuando resolve_product falla aunque el ToolMessage sea success', async () => {
    const resolveEffect = vi.fn();
    const addEffect = vi.fn();
    const node = new HumanIntentToolNode([
      makeTool('search_products', vi.fn()),
      makeResolveProductTool(resolveEffect, false),
      makeAddCartItemTool(addEffect),
    ]);

    const result = await node.invoke(
      {
        messages: [toolCalls([
          { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
          { id: 'resolve-1', name: 'resolve_product', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
          { id: 'add-1', name: 'add_cart_item', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
        ])],
      },
      config()
    );

    expect(resolveEffect).toHaveBeenCalledOnce();
    expect(addEffect).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.messages[2].content))).toMatchObject({
      success: false,
      error: 'resolution_missing',
    });
  });

  it('no habilita add_cart_item con un resolve_product de otro producto', async () => {
    const addEffect = vi.fn();
    const resolveEffect = vi.fn();
    const node = new HumanIntentToolNode([
      makeTool('search_products', vi.fn()),
      makeResolveProductTool(resolveEffect),
      makeAddCartItemTool(addEffect),
    ]);

    const result = await node.invoke(
      {
        messages: [toolCalls([
          { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
          { id: 'resolve-1', name: 'resolve_product', args: { productId: OTHER_PRODUCT_ID, resolutionId: 'resolution-1' } },
          { id: 'add-1', name: 'add_cart_item', args: { productId: PRODUCT_ID } },
        ])],
      },
      config()
    );

    expect(resolveEffect).toHaveBeenCalledOnce();
    expect(resolveProductForAddMock).not.toHaveBeenCalled();
    expect(addEffect).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.messages[2].content))).toMatchObject({
      success: false,
      error: 'missing_producer_or_requirement',
    });
  });

  it('ejecuta la búsqueda y difiere el alta prematura al siguiente ciclo', async () => {
    const events: string[] = [];
    const addEffect = vi.fn();
    const node = new HumanIntentToolNode([
      makeTool('search_products', () => { events.push('search'); }),
      makeAddCartItemTool(addEffect),
    ]);

    const result = await node.invoke(
      {
        messages: [toolCalls([
          { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
          { id: 'add-1', name: 'add_cart_item', args: { productId: PRODUCT_ID } },
        ])],
      },
      config()
    );

    expect(resolveProductForAddMock).toHaveBeenCalledOnce();
    expect(events).toEqual(['search']);
    expect(addEffect).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.messages[1].content))).toMatchObject({
      success: false,
      error: 'product_resolution_required',
    });
  });

  it('permite alta con ProductResolution producida en la cadena del planner', async () => {
    const searchEffect = vi.fn();
    const resolveEffect = vi.fn();
    const addEffect = vi.fn();
    const node = new HumanIntentToolNode([
      makeTool('search_products', searchEffect),
      makeResolveProductTool(resolveEffect),
      makeAddCartItemTool(addEffect),
    ]);

    await node.invoke(
      {
        messages: [toolCalls([
          { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
          { id: 'resolve-1', name: 'resolve_product', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
          { id: 'add-1', name: 'add_cart_item', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
        ])],
      },
      config()
    );

    expect(searchEffect).toHaveBeenCalledOnce();
    expect(resolveEffect).toHaveBeenCalledOnce();
    expect(addEffect).toHaveBeenCalledOnce();
    expect(resolveProductForAddMock).not.toHaveBeenCalled();
  });
  describe('DEFER accionable de add_cart_item Task-bound', () => {
    const ORDER_LINE_ID = 'line-papas';
    // Mismo formato largo que emite search_products (pr1:<business>:<conversation>:<uuid>).
    const RESOLUTION_ID =
      'pr1:e89dfb88-a409-4818-a01e-37d7d5ba2e11:e7a0c769-faf0-4940-a822-26f1389dc2bc:f07eccea-59e5-4805-863b-93daf538f44c';
    const taskMetadata = (currentResolutionId: string | null) => ({
      peopleCount: 3,
      pendingOrderLines: {
        lines: [
          { id: 'line-ceviche', hint: 'ceviche', requestedQuantity: 2, status: 'done', currentResolutionId: 'pr1:biz-1:conv-1:res-ceviche' },
          { id: ORDER_LINE_ID, hint: 'papas', requestedQuantity: null, status: 'active', currentResolutionId },
        ],
        sourceMessage: 'Quiero un ceviche y unas papas',
        createdAt: '2026-10-07T00:00:00.000Z',
      },
      productResolutions: [{
        resolutionId: RESOLUTION_ID,
        productId: PRODUCT_ID,
        businessId: 'biz-1',
        conversationId: 'conv-1',
        source: 'search_products',
        status: 'candidate',
        scope: 'conversation',
        createdAt: '2026-10-07T00:00:00.000Z',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }],
    });
    const invokeAdd = async (args: Record<string, unknown>) => {
      const effect = vi.fn();
      const node = new HumanIntentToolNode([makeAddCartItemTool(effect)]);
      const result = await node.invoke(
        { messages: [toolCalls([{ id: 'add-papas', name: 'add_cart_item', args }])] },
        config()
      );
      const message = result.messages[0] as ToolMessage;
      return { effect, message, payload: JSON.parse(String(message.content)) as Record<string, unknown> };
    };

    it('Caso 1 — sin asociación Task–ProductResolution difiere y señala resolve_product con los IDs de la call', async () => {
      conversationStateFindUniqueMock.mockResolvedValue({ metadata: taskMetadata(null) });

      const { payload, message } = await invokeAdd({
        orderLineId: ORDER_LINE_ID,
        productId: PRODUCT_ID,
        resolutionId: RESOLUTION_ID,
      });

      expect(message.tool_call_id).toBe('add-papas');
      expect(payload).toMatchObject({
        success: false,
        error: 'product_resolution_required',
        reason: 'task_resolution_mismatch',
        missingRequirements: ['TASK_RESOLUTION_PAIR'],
        nextRequiredTool: 'resolve_product',
        nextRequiredToolArgs: { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: RESOLUTION_ID },
      });
      expect(payload.instruction).toMatch(/resolve_product/);
    });

    it('Caso 2A — Task sin resolución: conserva el resolutionId largo con igualdad exacta', async () => {
      conversationStateFindUniqueMock.mockResolvedValue({ metadata: taskMetadata(null) });

      const { payload } = await invokeAdd({
        orderLineId: ORDER_LINE_ID,
        productId: PRODUCT_ID,
        resolutionId: RESOLUTION_ID,
      });
      const args = payload.nextRequiredToolArgs as Record<string, string>;

      expect(payload.reason).toBe('task_resolution_mismatch');
      expect(payload.nextRequiredTool).toBe('resolve_product');
      expect(args.resolutionId === RESOLUTION_ID).toBe(true);
      expect(args.resolutionId.length).toBe(RESOLUTION_ID.length);
      expect(args.orderLineId === ORDER_LINE_ID).toBe(true);
      expect(args.productId === PRODUCT_ID).toBe(true);
    });

    it('Caso 2B — Task con otra resolución: fail closed, sin nextRequiredTool ni mutaciones', async () => {
      const EXISTING_RESOLUTION_ID = 'pr1:biz-1:conv-1:res-existente';
      const metadata = taskMetadata(EXISTING_RESOLUTION_ID);
      const before = structuredClone(metadata);
      conversationStateFindUniqueMock.mockResolvedValue({ metadata });
      const resolveEffect = vi.fn();
      const addEffect = vi.fn();
      const node = new HumanIntentToolNode([
        makeAddCartItemTool(addEffect),
        makeResolveProductTool(resolveEffect),
      ]);

      const result = await node.invoke(
        { messages: [toolCalls([{
          id: 'add-papas',
          name: 'add_cart_item',
          args: { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: RESOLUTION_ID },
        }])] },
        config()
      );
      const payload = JSON.parse(String((result.messages[0] as ToolMessage).content)) as Record<string, unknown>;

      expect(payload).toMatchObject({
        success: false,
        error: 'product_resolution_required',
        reason: 'task_resolution_mismatch',
        missingRequirements: ['TASK_RESOLUTION_PAIR'],
      });
      expect(payload.nextRequiredTool).toBeUndefined();
      expect(payload.nextRequiredToolArgs).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain('resolve_product');
      expect(resolveEffect).not.toHaveBeenCalled();
      expect(addEffect).not.toHaveBeenCalled();
      expect(patchConversationMetadataMock).not.toHaveBeenCalled();
      expect(metadata).toEqual(before);
      expect(metadata.pendingOrderLines.lines[1].currentResolutionId).toBe(EXISTING_RESOLUTION_ID);
    });

    it('Caso 2C — Task QUEUED sin resolución: fail closed, sin nextRequiredTool', async () => {
      const metadata = taskMetadata(null);
      metadata.pendingOrderLines.lines[1].status = 'queued';
      conversationStateFindUniqueMock.mockResolvedValue({ metadata });

      const { payload } = await invokeAdd({
        orderLineId: ORDER_LINE_ID,
        productId: PRODUCT_ID,
        resolutionId: RESOLUTION_ID,
      });

      expect(payload.reason).toBe('task_resolution_mismatch');
      expect(payload.nextRequiredTool).toBeUndefined();
      expect(payload.nextRequiredToolArgs).toBeUndefined();
      expect(JSON.stringify(payload)).not.toContain('resolve_product');
    });

    describe('recuperación canónica de task_resolution_mismatch (Task ACTIVE con resolución propia)', () => {
      const R1 =
        'pr1:e89dfb88-a409-4818-a01e-37d7d5ba2e11:e7a0c769-faf0-4940-a822-26f1389dc2bc:aaaaaaaa-1111-4222-8333-444444444444';
      const r1Entry = (over: Record<string, unknown> = {}) => ({
        resolutionId: R1,
        productId: PRODUCT_ID,
        businessId: 'biz-1',
        conversationId: 'conv-1',
        source: 'search_products',
        status: 'selected',
        scope: 'turn',
        turnId: 'turn-anterior',
        createdAt: '2026-10-07T00:00:00.000Z',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        ...over,
      });
      const metadataWithR1 = (entry: Record<string, unknown> | null, otherOwner = false) => {
        const metadata = taskMetadata(R1);
        if (otherOwner) metadata.pendingOrderLines.lines[0].currentResolutionId = R1;
        return {
          ...metadata,
          productResolutions: [...metadata.productResolutions, ...(entry ? [entry] : [])],
        };
      };

      it('TEST A/B/C — mismatch con R2: nextRequiredTool add_cart_item con exactamente R1 (nunca resolve_product)', async () => {
        const metadata = metadataWithR1(r1Entry());
        const before = structuredClone(metadata);
        conversationStateFindUniqueMock.mockResolvedValue({ metadata });

        const { payload, effect } = await invokeAdd({
          orderLineId: ORDER_LINE_ID,
          productId: PRODUCT_ID,
          resolutionId: RESOLUTION_ID,
        });
        const args = payload.nextRequiredToolArgs as Record<string, string>;

        expect(payload).toMatchObject({ success: false, reason: 'task_resolution_mismatch', nextRequiredTool: 'add_cart_item' });
        expect(payload.nextRequiredTool).not.toBe('resolve_product');
        expect(args.resolutionId === R1).toBe(true);
        expect(args.resolutionId.length).toBe(R1.length);
        expect(args.orderLineId === ORDER_LINE_ID).toBe(true);
        expect(args.productId === PRODUCT_ID).toBe(true);
        expect(String(payload.instruction)).toMatch(/No vuelvas a buscar ni resolver/);
        expect(effect).not.toHaveBeenCalled();
        expect(patchConversationMetadataMock).not.toHaveBeenCalled();
        expect(metadata).toEqual(before);
      });

      it.each([
        ['consumida', r1Entry({ status: 'consumed' }), false],
        ['vencida por TTL', r1Entry({ expiresAt: new Date(Date.now() - 1_000).toISOString() }), false],
        ['inexistente en el ledger', null, false],
        ['de otro business', r1Entry({ businessId: 'biz-otro' }), false],
        ['compartida con otra Task', r1Entry(), true],
      ])('TEST F — R1 %s: fail closed, sin resolución de reemplazo', async (_label, entry, otherOwner) => {
        conversationStateFindUniqueMock.mockResolvedValue({ metadata: metadataWithR1(entry as Record<string, unknown> | null, otherOwner as boolean) });

        const { payload } = await invokeAdd({
          orderLineId: ORDER_LINE_ID,
          productId: PRODUCT_ID,
          resolutionId: RESOLUTION_ID,
        });

        expect(payload.reason).toBe('task_resolution_mismatch');
        expect(payload.nextRequiredTool).toBeUndefined();
        expect(payload.nextRequiredToolArgs).toBeUndefined();
        expect(isFailClosedTaskRejection(payload)).toBe(true);
      });
    });

    it('Caso 3 — el DEFER no muta estado: sin add, sin consumo, sin asociación, Task y cantidad intactas', async () => {
      const metadata = taskMetadata(null);
      const before = structuredClone(metadata);
      conversationStateFindUniqueMock.mockResolvedValue({ metadata });

      const { effect, payload } = await invokeAdd({
        orderLineId: ORDER_LINE_ID,
        productId: PRODUCT_ID,
        resolutionId: RESOLUTION_ID,
      });

      expect(payload.nextRequiredTool).toBe('resolve_product');
      expect(effect).not.toHaveBeenCalled();
      expect(patchConversationMetadataMock).not.toHaveBeenCalled();
      expect(resolveProductForAddMock).not.toHaveBeenCalled();
      expect(reconcileAfterToolMock).not.toHaveBeenCalled();
      expect(metadata).toEqual(before);
    });

    it('Caso 4 — fuera del flujo Task-bound el DEFER conserva su shape previo', async () => {
      conversationStateFindUniqueMock.mockResolvedValue({ metadata: { peopleCount: 2 } });

      const { payload } = await invokeAdd({ productId: PRODUCT_ID, resolutionId: RESOLUTION_ID });

      expect(payload).toEqual({
        success: false,
        error: 'product_resolution_required',
        reason: 'resolution_missing',
        missingRequirements: ['PRODUCT_RESOLVED'],
        message: 'El producto todavía no tiene una resolución vigente.',
        instruction: 'Esperá a que se satisfagan los requisitos del flujo antes de ejecutar esta tool.',
      });
    });

    it('Caso 4b — otras fallas Task-bound no señalan resolve_product', async () => {
      const metadata = taskMetadata(null);
      (metadata.pendingOrderLines.lines[0] as { currentResolutionId: string | null }).currentResolutionId = RESOLUTION_ID;
      conversationStateFindUniqueMock.mockResolvedValue({ metadata: { ...metadata, pendingOrderLines: {
        ...metadata.pendingOrderLines,
        lines: [
          { ...metadata.pendingOrderLines.lines[0], status: 'active' },
          { ...metadata.pendingOrderLines.lines[1], currentResolutionId: RESOLUTION_ID },
        ],
      } } });

      const { payload } = await invokeAdd({
        orderLineId: ORDER_LINE_ID,
        productId: PRODUCT_ID,
        resolutionId: RESOLUTION_ID,
      });

      expect(payload.reason).toBe('resolution_already_owned');
      expect(payload.nextRequiredTool).toBeUndefined();
      expect(payload.nextRequiredToolArgs).toBeUndefined();
    });
  });

  it('findDeclaredProducer deriva el productor del contrato', () => {
    expect(findDeclaredProducer('add_cart_item', PRODUCT_RESOLUTION)).toBe('resolve_product');
    expect(findDeclaredProducer('resolve_product', PRODUCT_RESOLUTION)).toBeNull();
    expect(findDeclaredProducer('add_cart_item', PRODUCT_CANDIDATE)).toBeNull();
    expect(findDeclaredProducer('resolve_product', PRODUCT_CANDIDATE)).toBe('search_products');
  });

  describe('collectRequestTargets — products enriquecidos {name, note}', () => {
    it('G — products:[{name,note}] expone el nombre del producto como target', () => {
      const targets = collectRequestTargets({
        products: [{ name: 'ceviche', note: 'poca cebolla' }],
      });
      expect(targets).toContain('ceviche');
      expect(targets).not.toContain('poca cebolla');
    });

    it('legacy: products:string[] sigue exponiendo cada string como target', () => {
      const targets = collectRequestTargets({ products: ['ceviche', 'papas a la huancaína'] });
      expect(targets).toEqual(['ceviche', 'papas a la huancaína']);
    });

    it('products:[{name,note}] con dos líneas expone ambos nombres sin mezclar notas', () => {
      const targets = collectRequestTargets({
        products: [
          { name: 'ceviche', note: 'poca cebolla' },
          { name: 'papas a la huancaína', note: 'no muy picantes' },
        ],
      });
      expect(targets).toEqual(['ceviche', 'papas a la huancaína']);
    });

    it('no amplía "name" como target fuera de un array de products (sin falsos positivos)', () => {
      const targets = collectRequestTargets({ category: { name: 'postres' } });
      expect(targets).toEqual([]);
    });
  });
});
