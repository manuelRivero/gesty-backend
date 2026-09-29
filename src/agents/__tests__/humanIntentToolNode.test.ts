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

vi.mock('../../services/productResolution.service', () => ({
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

const makeAddCartItemTool = (effect: () => unknown) =>
  new DynamicStructuredTool({
    name: 'add_cart_item',
    description: 'test tool',
    schema: z.object({ productId: z.string().uuid() }),
    func: async () => {
      await effect();
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
    func: async () => {
      await effect();
      return JSON.stringify({ success, productId: PRODUCT_ID, resolutionId: 'resolution-1' });
    },
  });

const config = (revision = 7) => ({
  configurable: {
    conversationId: 'conv-1',
    customerPhone: '+5491100000000',
    businessId: 'biz-1',
    humanIntentGateRevision: revision,
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

  it('permite ejecutar una tool cuyo target coincide con ACTIVE', async () => {
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeTool('search_products', effect)]);

    const result = await node.invoke({ messages: [toolCall('search_products', { keyword: 'ceviche' })] }, config());

    expect(effect).toHaveBeenCalledOnce();
    expect(result.messages[0]).toMatchObject({ status: 'success' });
    expect(reconcileAfterToolMock).not.toHaveBeenCalled();
  });

  it('reconcilia después de ejecutar una tool autorizada y exitosa', async () => {
    resolveProductForAddMock.mockResolvedValue({ ok: true, resolution: { productId: PRODUCT_ID } });
    const node = new HumanIntentToolNode([makeAddCartItemTool(vi.fn())]);

    await node.invoke(
      { messages: [toolCall('add_cart_item', { productId: PRODUCT_ID })] },
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
    expect(resolveProductForAddMock).toHaveBeenCalledOnce();
  });

  it('difiere el ADD sin ProductResolution vigente sin ejecutar la tool', async () => {
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeAddCartItemTool(effect)]);

    const result = await node.invoke(
      { messages: [toolCall('add_cart_item', { productId: PRODUCT_ID })] },
      config()
    );

    expect(effect).not.toHaveBeenCalled();
    expect(result.messages[0]).toMatchObject({ status: 'success' });
    expect(JSON.parse(String(result.messages[0].content))).toMatchObject({
      success: false,
      error: 'product_resolution_required',
      missingRequirements: ['PRODUCT_RESOLVED'],
    });
  });

  it('difiere el ADD sin party size aunque ProductResolution sea válida', async () => {
    resolveProductForAddMock.mockResolvedValue({ ok: true, resolution: { productId: PRODUCT_ID } });
    conversationStateFindUniqueMock.mockResolvedValue({ metadata: {} });
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeAddCartItemTool(effect)]);

    const result = await node.invoke(
      { messages: [toolCall('add_cart_item', { productId: PRODUCT_ID })] },
      config()
    );

    expect(effect).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.messages[0].content))).toMatchObject({
      success: false,
      error: 'party_size_required',
      pending: true,
      heldOrder: 'Ceviche Clásico',
      missingRequirements: ['PARTY_SIZE_OBTAINED'],
    });
    expect(persistedConversationMetadata.pendingPartySizeOrder).toMatchObject({
      source: 'lookup',
      summary: 'Ceviche Clásico',
      turnStartedAt: null,
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

  it('no consulta Prisma para un productId que el schema rechazará', async () => {
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
    const node = new HumanIntentToolNode([makeAddCartItemTool(effect)]);

    const result = await node.invoke(
      { messages: [toolCall('add_cart_item', { productId: PRODUCT_ID })] },
      config()
    );
    const message = result.messages[0] as ToolMessage;

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
    const node = new HumanIntentToolNode([
      makeTool('search_products', () => { events.push('search'); }),
      makeResolveProductTool(() => { events.push('resolve'); }),
      makeAddCartItemTool(() => { events.push('add'); }),
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
    expect(resolveProductForAddMock).not.toHaveBeenCalled();
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
      makeResolveProductTool(resolveEffect, false),
      makeAddCartItemTool(addEffect),
    ]);

    const result = await node.invoke(
      {
        messages: [toolCalls([
          { id: 'resolve-1', name: 'resolve_product', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
          { id: 'add-1', name: 'add_cart_item', args: { productId: PRODUCT_ID, resolutionId: 'resolution-1' } },
        ])],
      },
      config()
    );

    expect(resolveEffect).toHaveBeenCalledOnce();
    expect(addEffect).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.messages[1].content))).toMatchObject({
      success: false,
      error: 'product_resolution_required',
    });
  });

  it('no habilita add_cart_item con un resolve_product de otro producto', async () => {
    const addEffect = vi.fn();
    const resolveEffect = vi.fn();
    const node = new HumanIntentToolNode([
      makeResolveProductTool(resolveEffect),
      makeAddCartItemTool(addEffect),
    ]);

    const result = await node.invoke(
      {
        messages: [toolCalls([
          { id: 'resolve-1', name: 'resolve_product', args: { productId: OTHER_PRODUCT_ID, resolutionId: 'resolution-1' } },
          { id: 'add-1', name: 'add_cart_item', args: { productId: PRODUCT_ID } },
        ])],
      },
      config()
    );

    expect(resolveEffect).toHaveBeenCalledOnce();
    expect(resolveProductForAddMock).toHaveBeenCalledWith(expect.objectContaining({ productId: PRODUCT_ID }));
    expect(addEffect).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.messages[1].content))).toMatchObject({
      success: false,
      error: 'product_resolution_required',
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

    expect(resolveProductForAddMock).toHaveBeenCalledWith({
      productId: PRODUCT_ID,
      businessId: 'biz-1',
      conversationId: 'conv-1',
      resolutionId: undefined,
      turnId: undefined,
    });
    expect(events).toEqual(['search']);
    expect(addEffect).not.toHaveBeenCalled();
    expect(JSON.parse(String(result.messages[1].content))).toMatchObject({
      success: false,
      error: 'product_resolution_required',
    });
  });

  it('permite alta junto a una búsqueda si ProductResolution ya valida el producto', async () => {
    resolveProductForAddMock.mockResolvedValue({ ok: true, resolution: { productId: PRODUCT_ID } });
    const searchEffect = vi.fn();
    const addEffect = vi.fn();
    const node = new HumanIntentToolNode([
      makeTool('search_products', searchEffect),
      makeAddCartItemTool(addEffect),
    ]);

    await node.invoke(
      {
        messages: [toolCalls([
          { id: 'search-1', name: 'search_products', args: { keyword: 'ceviche' } },
          { id: 'add-1', name: 'add_cart_item', args: { productId: PRODUCT_ID } },
        ])],
      },
      config()
    );

    expect(searchEffect).toHaveBeenCalledOnce();
    expect(addEffect).toHaveBeenCalledOnce();
    expect(resolveProductForAddMock).toHaveBeenCalledOnce();
  });
});