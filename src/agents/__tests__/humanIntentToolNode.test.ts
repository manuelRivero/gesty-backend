import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { getStateMock, itemFindFirstMock, categoryFindFirstMock } = vi.hoisted(() => ({
  getStateMock: vi.fn(),
  itemFindFirstMock: vi.fn(),
  categoryFindFirstMock: vi.fn(),
}));

vi.mock('../../services/humanIntentState.service', () => ({
  getHumanIntentState: getStateMock,
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    menu_item: { findFirst: itemFindFirstMock, findMany: vi.fn() },
    menu_category: { findFirst: categoryFindFirstMock },
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

const state = (records: Array<Record<string, unknown>> = [ACTIVE, PENDING], revision = 7) => ({
  version: 1 as const,
  revision,
  nextSequence: records.length + 1,
  processedMessageIds: ['wamid-turn'],
  records,
});

const toolCall = (name: string, args: Record<string, unknown>) =>
  new AIMessage({
    content: '',
    tool_calls: [{ id: `call-${name}`, name, args, type: 'tool_call' }],
  });

const makeTool = (name: string, effect: ReturnType<typeof vi.fn>) =>
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

const config = (revision = 7) => ({
  configurable: {
    conversationId: 'conv-1',
    businessId: 'biz-1',
    humanIntentGateRevision: revision,
  },
});

describe('HumanIntentToolNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getStateMock.mockResolvedValue(state());
    itemFindFirstMock.mockResolvedValue({ name: 'Ceviche Clásico' });
    categoryFindFirstMock.mockResolvedValue({ name: 'Postres' });
  });

  it('permite ejecutar una tool cuyo target coincide con ACTIVE', async () => {
    const effect = vi.fn();
    const node = new HumanIntentToolNode([makeTool('search_products', effect)]);

    const result = await node.invoke({ messages: [toolCall('search_products', { keyword: 'ceviche' })] }, config());

    expect(effect).toHaveBeenCalledOnce();
    expect(result.messages[0]).toMatchObject({ status: 'success' });
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
});