/**
 * Terminación del turno ReAct: un DEFER que necesita input humano (askMessage,
 * sin nextRequiredTool) corta el grafo; un DEFER accionable (nextRequiredTool)
 * deja seguir al modelo. Corre sobre el grafo real de createReactAgent.
 *
 * Evidencia (E2E human-intent-lifecycle, TURN 6): tras add_cart_item →
 * order_line_quantity_required el modelo siguió con clear_pending_add_quantity y
 * set_order_line_quantity(2) hasta el recursionLimit, y el cliente no recibió nada.
 */

import { describe, expect, it, vi } from 'vitest';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';

vi.mock('../../lib/prisma', () => ({ prisma: {} }));

import { HumanIntentToolNode, requiresUserInput } from '../humanIntentToolNode';
import { runAgentUntilUserInput, stepAwaitsUserInput, stepEndsTurn } from '../reactAgent';

const ORDER_LINE_ID = 'line-papas';
const PRODUCT_ID = '7899fdd4-e838-4f3f-9c07-02771774c8ae';
const RESOLUTION_ID =
  'pr1:e89dfb88-a409-4818-a01e-37d7d5ba2e11:e7a0c769-faf0-4940-a822-26f1389dc2bc:f07eccea-59e5-4805-863b-93daf538f44c';
const ASK = '¿Cuántas unidades de Papa a la huancaina querés agregar?';

const QUANTITY_DEFER = {
  success: false,
  error: 'order_line_quantity_required',
  reason: 'order_line_quantity_required',
  missingRequirements: ['ORDER_LINE_QUANTITY_PERSISTED'],
  message: 'La línea del pedido todavía no tiene una cantidad confirmada.',
  askMessage: ASK,
  instruction: 'No agregues el producto. Preguntá cuántas unidades quiere y esperá su respuesta; la cantidad se persiste con set_order_line_quantity.',
};

const RESOLUTION_DEFER = {
  success: false,
  error: 'product_resolution_required',
  reason: 'task_resolution_mismatch',
  missingRequirements: ['TASK_RESOLUTION_PAIR'],
  message: 'La resolución del producto todavía no está asociada a esta línea del pedido.',
  nextRequiredTool: 'resolve_product',
  nextRequiredToolArgs: { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: RESOLUTION_ID },
  instruction: 'No reintentes add_cart_item todavía. Primero llamá resolve_product con exactamente nextRequiredToolArgs.',
};

/** Modelo con guion: devuelve los AIMessage en orden y cuenta las llamadas. */
class ScriptedChatModel extends BaseChatModel {
  calls = 0;

  constructor(private readonly script: AIMessage[]) {
    super({});
  }

  _llmType(): string {
    return 'scripted';
  }

  bindTools(): this {
    return this;
  }

  async _generate(_messages: BaseMessage[]): Promise<ChatResult> {
    const message = this.script[this.calls] ?? new AIMessage('fin del guion');
    this.calls += 1;
    return { generations: [{ message, text: typeof message.content === 'string' ? message.content : '' }] };
  }
}

const aiCall = (name: string, args: Record<string, unknown>, id = `call-${name}-${Math.random()}`) =>
  new AIMessage({ content: '', tool_calls: [{ id, name, args, type: 'tool_call' }] });

const fakeTool = (name: string, payloads: unknown[], options: { returnDirect?: boolean } = {}) => {
  const spy = vi.fn();
  let index = 0;
  const tool = new DynamicStructuredTool({
    name,
    description: `fake ${name}`,
    schema: z.object({
      orderLineId: z.string().optional(),
      productId: z.string().optional(),
      resolutionId: z.string().optional(),
      quantity: z.number().optional(),
    }),
    func: async (args) => {
      spy(args);
      const payload = payloads[Math.min(index, payloads.length - 1)];
      index += 1;
      return JSON.stringify(payload);
    },
  });
  if (options.returnDirect) (tool as typeof tool & { returnDirect: boolean }).returnDirect = true;
  return { tool, spy };
};

const buildAgent = (model: ScriptedChatModel, tools: DynamicStructuredTool[]) =>
  createReactAgent({ llm: model, tools: new HumanIntentToolNode(tools) });

const userTurn = (text: string) => ({ messages: [new HumanMessage(text)] as BaseMessage[] });

const lastPayload = (state: { messages?: unknown[] }) => {
  const messages = state.messages ?? [];
  const last = messages[messages.length - 1] as ToolMessage | undefined;
  return JSON.parse(String(last?.content)) as Record<string, unknown>;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('requiresUserInput', () => {
  it('distingue el DEFER que pide input humano del DEFER accionable por otro tool', () => {
    expect(requiresUserInput(QUANTITY_DEFER)).toBe(true);
    expect(requiresUserInput(RESOLUTION_DEFER)).toBe(false);
    expect(requiresUserInput({ ...RESOLUTION_DEFER, askMessage: ASK })).toBe(false);
    expect(requiresUserInput({ success: true, askMessage: 'nota' })).toBe(false);
    expect(requiresUserInput({ success: false, error: 'product_not_found' })).toBe(false);
  });

  it('un paso con un efecto exitoso no corta el turno aunque otro resultado pida input', () => {
    const run = [
      new ToolMessage({ tool_call_id: 'a', name: 'add_cart_item', content: JSON.stringify({ success: true, effect: { kind: 'cart_item_persisted' } }) }),
      new ToolMessage({ tool_call_id: 'b', name: 'add_cart_item', content: JSON.stringify(QUANTITY_DEFER) }),
    ];
    expect(stepAwaitsUserInput(run, 0)).toBe(false);
    expect(stepAwaitsUserInput([run[1]], 0)).toBe(true);
  });
});

describe('runAgentUntilUserInput sobre el grafo real', () => {
  it('Test A/B — "Sí, seguí" + order_line_quantity_required termina el turno con el askMessage y sin otra tool', async () => {
    const model = new ScriptedChatModel([
      aiCall('add_cart_item', { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: RESOLUTION_ID }),
      aiCall('clear_pending_add_quantity', {}),
      aiCall('set_order_line_quantity', { orderLineId: ORDER_LINE_ID, quantity: 2 }),
      aiCall('add_cart_item', { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: RESOLUTION_ID, quantity: 2 }),
    ]);
    const add = fakeTool('add_cart_item', [QUANTITY_DEFER]);
    const clear = fakeTool('clear_pending_add_quantity', [{ cleared: true }]);
    const setQuantity = fakeTool('set_order_line_quantity', [{ success: true, effect: { kind: 'order_line_quantity_persisted' } }]);

    const state = await runAgentUntilUserInput(
      buildAgent(model, [add.tool, clear.tool, setQuantity.tool]) as never,
      userTurn('Sí, seguí'),
      { recursionLimit: 12 }
    );
    await settle();

    expect(lastPayload(state)).toEqual(QUANTITY_DEFER);
    expect(model.calls).toBe(1);
    expect(add.spy).toHaveBeenCalledOnce();
    expect(clear.spy).not.toHaveBeenCalled();
    expect(setQuantity.spy).not.toHaveBeenCalled();
    const quantities = (state.messages ?? []).flatMap((message) =>
      ((message as AIMessage).tool_calls ?? []).map((call) => call.args.quantity)
    );
    expect(quantities.filter((quantity) => quantity != null)).toEqual([]);
  });

  it('Test A — corta aunque el DEFER llegue en la 6.ª iteración (sin recursion error)', async () => {
    const model = new ScriptedChatModel([
      ...Array.from({ length: 5 }, () => aiCall('get_cart', {})),
      aiCall('add_cart_item', { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: RESOLUTION_ID }),
      aiCall('set_order_line_quantity', { orderLineId: ORDER_LINE_ID, quantity: 2 }),
    ]);
    const cart = fakeTool('get_cart', [{ items: [] }]);
    const add = fakeTool('add_cart_item', [QUANTITY_DEFER]);
    const setQuantity = fakeTool('set_order_line_quantity', [{ success: true }]);

    const state = await runAgentUntilUserInput(
      buildAgent(model, [cart.tool, add.tool, setQuantity.tool]) as never,
      userTurn('Sí, seguí'),
      { recursionLimit: 12 }
    );
    await settle();

    expect(lastPayload(state)).toEqual(QUANTITY_DEFER);
    expect(model.calls).toBe(6);
    expect(setQuantity.spy).not.toHaveBeenCalled();
  });

  it('Test C — task_resolution_mismatch con nextRequiredTool no termina: resolve_product corre con los IDs exactos', async () => {
    const model = new ScriptedChatModel([
      aiCall('add_cart_item', { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: RESOLUTION_ID }),
      aiCall('resolve_product', { ...RESOLUTION_DEFER.nextRequiredToolArgs }),
      new AIMessage('¿Cuántas unidades querés?'),
    ]);
    const add = fakeTool('add_cart_item', [RESOLUTION_DEFER]);
    const resolve = fakeTool('resolve_product', [{ success: true, orderLineId: ORDER_LINE_ID, currentResolutionId: RESOLUTION_ID }]);

    const state = await runAgentUntilUserInput(
      buildAgent(model, [add.tool, resolve.tool]) as never,
      userTurn('Sí, seguí'),
      { recursionLimit: 12 }
    );

    expect(model.calls).toBe(3);
    expect(resolve.spy).toHaveBeenCalledOnce();
    const resolveArgs = resolve.spy.mock.calls[0][0] as Record<string, string>;
    expect(resolveArgs.orderLineId === ORDER_LINE_ID).toBe(true);
    expect(resolveArgs.productId === PRODUCT_ID).toBe(true);
    expect(resolveArgs.resolutionId === RESOLUTION_ID).toBe(true);
    expect(((state.messages ?? [])[(state.messages ?? []).length - 1] as AIMessage).content).toBe('¿Cuántas unidades querés?');
  });

  it('Test H — set_order_line_quantity con nextRequiredTool y add_cart_item corren en el mismo turno', async () => {
    const nextArgs = { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: RESOLUTION_ID, quantity: 2 };
    const model = new ScriptedChatModel([
      aiCall('set_order_line_quantity', { quantity: 2 }),
      aiCall('add_cart_item', { ...nextArgs }),
      new AIMessage('¡Listo! Agregué 2 ceviches.'),
    ]);
    const setQuantity = fakeTool('set_order_line_quantity', [{
      success: true,
      effect: { kind: 'order_line_quantity_persisted', reference: ORDER_LINE_ID },
      orderLine: { id: ORDER_LINE_ID, hint: 'ceviche', requestedQuantity: 2, status: 'active' },
      nextRequiredTool: 'add_cart_item',
      nextRequiredToolArgs: nextArgs,
    }]);
    const add = fakeTool('add_cart_item', [{ success: true, effect: { kind: 'cart_item_persisted', reference: PRODUCT_ID } }]);

    const state = await runAgentUntilUserInput(
      buildAgent(model, [setQuantity.tool, add.tool]) as never,
      userTurn('Dame 2'),
      { recursionLimit: 12 }
    );

    expect(model.calls).toBe(3);
    expect(setQuantity.spy).toHaveBeenCalledOnce();
    expect(add.spy).toHaveBeenCalledWith(nextArgs);
    expect(((state.messages ?? [])[(state.messages ?? []).length - 1] as AIMessage).content).toBe('¡Listo! Agregué 2 ceviches.');
  });

  it('TEST 5 — un add que cierra la Task termina el turno: cero tools después (sin search/resolve/continue)', async () => {
    const nextArgs = { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: RESOLUTION_ID, quantity: 2 };
    const model = new ScriptedChatModel([
      aiCall('set_order_line_quantity', { quantity: 2 }),
      aiCall('add_cart_item', { ...nextArgs }),
      aiCall('search_products', {}),
      aiCall('resolve_product', { orderLineId: 'line-papas-b' }),
      aiCall('continue_order_line', {}),
    ]);
    const setQuantity = fakeTool('set_order_line_quantity', [{
      success: true,
      effect: { kind: 'order_line_quantity_persisted', reference: ORDER_LINE_ID },
      orderLine: { id: ORDER_LINE_ID, hint: 'ceviche', requestedQuantity: 2, status: 'active' },
      nextRequiredTool: 'add_cart_item',
      nextRequiredToolArgs: nextArgs,
    }]);
    const addResult = {
      success: true,
      effect: { kind: 'cart_item_persisted', reference: PRODUCT_ID },
      closedOrderLine: { id: ORDER_LINE_ID, status: 'done' },
      queueFollowUp: { nextHint: 'papas', remaining: 1, instruction: 'ofrecé seguir con papas' },
    };
    const add = fakeTool('add_cart_item', [addResult]);
    const search = fakeTool('search_products', [{ count: 1, items: [] }]);
    const resolve = fakeTool('resolve_product', [{ success: true }]);
    const cont = fakeTool('continue_order_line', [{ success: true }]);

    const state = await runAgentUntilUserInput(
      buildAgent(model, [setQuantity.tool, add.tool, search.tool, resolve.tool, cont.tool]) as never,
      userTurn('Dame 2'),
      { recursionLimit: 12 }
    );
    await settle();

    expect(model.calls).toBe(2);
    expect(add.spy).toHaveBeenCalledOnce();
    expect(search.spy).not.toHaveBeenCalled();
    expect(resolve.spy).not.toHaveBeenCalled();
    expect(cont.spy).not.toHaveBeenCalled();
    expect(lastPayload(state)).toEqual(addResult);
    expect(stepEndsTurn(state.messages ?? [], 1)).toBe('fulfillment_completed');
  });

  describe('recuperación canónica de task_resolution_mismatch (TEST D / G)', () => {
    const R1 =
      'pr1:e89dfb88-a409-4818-a01e-37d7d5ba2e11:e7a0c769-faf0-4940-a822-26f1389dc2bc:aaaaaaaa-1111-4222-8333-444444444444';
    const TRUNCATED = 'pr1:e89dfb88-a409-4818-a01e-37d7d5ba2e11:e7a0c769-faf0-4940-a822-26f1389dc2bc';
    const canonicalArgs = { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: R1 };
    const canonicalMismatch = {
      success: false,
      error: 'product_resolution_required',
      reason: 'task_resolution_mismatch',
      missingRequirements: ['TASK_RESOLUTION_PAIR'],
      nextRequiredTool: 'add_cart_item',
      nextRequiredToolArgs: canonicalArgs,
      instruction: 'La línea ya tiene una resolución válida. Reintentá add_cart_item usando exactamente nextRequiredToolArgs.',
    };
    const failClosedMismatch = {
      success: false,
      error: 'product_resolution_required',
      reason: 'task_resolution_mismatch',
      missingRequirements: ['TASK_RESOLUTION_PAIR'],
    };
    const tail = () => [aiCall('add_cart_item', canonicalArgs), aiCall('search_products', {}), aiCall('resolve_product', {}), aiCall('continue_order_line', {})];
    const extraTools = () => ({
      search: fakeTool('search_products', [{ count: 1, items: [] }]),
      resolve: fakeTool('resolve_product', [{ success: true }]),
      cont: fakeTool('continue_order_line', [{ success: true }]),
    });

    it('TEST G — ID truncado → recuperación canónica → add con R1 → fulfillment y fin de turno', async () => {
      const model = new ScriptedChatModel([
        aiCall('add_cart_item', { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: TRUNCATED }),
        ...tail(),
      ]);
      const added = { success: true, effect: { kind: 'cart_item_persisted', reference: PRODUCT_ID }, closedOrderLine: { id: ORDER_LINE_ID, status: 'done' } };
      const add = fakeTool('add_cart_item', [canonicalMismatch, added]);
      const { search, resolve, cont } = extraTools();

      const state = await runAgentUntilUserInput(
        buildAgent(model, [add.tool, search.tool, resolve.tool, cont.tool]) as never,
        userTurn('Agregalo'),
        { recursionLimit: 12 }
      );
      await settle();

      expect(add.spy).toHaveBeenCalledTimes(2);
      expect(add.spy.mock.calls[1][0]).toEqual(canonicalArgs);
      expect(lastPayload(state)).toEqual(added);
      expect(search.spy).not.toHaveBeenCalled();
      expect(resolve.spy).not.toHaveBeenCalled();
      expect(cont.spy).not.toHaveBeenCalled();
    });

    it('TEST D — si el reintento canónico vuelve a dar mismatch, el turno termina: sin tercer add ni search/resolve/continue', async () => {
      const model = new ScriptedChatModel([
        aiCall('add_cart_item', { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: TRUNCATED }),
        ...tail(),
        aiCall('add_cart_item', canonicalArgs),
      ]);
      const add = fakeTool('add_cart_item', [canonicalMismatch, canonicalMismatch, canonicalMismatch]);
      const { search, resolve, cont } = extraTools();

      const state = await runAgentUntilUserInput(
        buildAgent(model, [add.tool, search.tool, resolve.tool, cont.tool]) as never,
        userTurn('Agregalo'),
        { recursionLimit: 12 }
      );
      await settle();

      expect(add.spy).toHaveBeenCalledTimes(2);
      expect(model.calls).toBe(2);
      expect(search.spy).not.toHaveBeenCalled();
      expect(resolve.spy).not.toHaveBeenCalled();
      expect(cont.spy).not.toHaveBeenCalled();
      expect(stepEndsTurn(state.messages ?? [], 1)).toBe('task_recovery_failed');
    });

    it('TEST F — mismatch fail closed (sin recuperación) termina el turno de inmediato', async () => {
      const model = new ScriptedChatModel([
        aiCall('add_cart_item', { orderLineId: ORDER_LINE_ID, productId: PRODUCT_ID, resolutionId: TRUNCATED }),
        ...tail(),
      ]);
      const add = fakeTool('add_cart_item', [failClosedMismatch, failClosedMismatch]);
      const { search, resolve, cont } = extraTools();

      const state = await runAgentUntilUserInput(
        buildAgent(model, [add.tool, search.tool, resolve.tool, cont.tool]) as never,
        userTurn('Agregalo'),
        { recursionLimit: 12 }
      );
      await settle();

      expect(model.calls).toBe(1);
      expect(add.spy).toHaveBeenCalledOnce();
      expect(search.spy).not.toHaveBeenCalled();
      expect(stepEndsTurn(state.messages ?? [], 1)).toBe('task_recovery_failed');
    });
  });

  it('TEST E — operar una Task QUEUED (task_not_active) termina el turno: sin search/resolve/add/continue después', async () => {
    const model = new ScriptedChatModel([
      aiCall('resolve_product', { orderLineId: 'line-papas', productId: PRODUCT_ID, resolutionId: RESOLUTION_ID }),
      aiCall('search_products', {}),
      aiCall('resolve_product', { orderLineId: 'line-papas' }),
      aiCall('add_cart_item', { orderLineId: 'line-papas' }),
      aiCall('continue_order_line', {}),
    ]);
    const resolve = fakeTool('resolve_product', [{ success: false, error: 'task_not_active', instruction: 'Esta línea del pedido todavía no está activa' }]);
    const search = fakeTool('search_products', [{ count: 1, items: [] }]);
    const add = fakeTool('add_cart_item', [{ success: true }]);
    const cont = fakeTool('continue_order_line', [{ success: true }]);

    const state = await runAgentUntilUserInput(
      buildAgent(model, [resolve.tool, search.tool, add.tool, cont.tool]) as never,
      userTurn('El primero'),
      { recursionLimit: 12 }
    );
    await settle();

    expect(model.calls).toBe(1);
    expect(resolve.spy).toHaveBeenCalledOnce();
    expect(search.spy).not.toHaveBeenCalled();
    expect(add.spy).not.toHaveBeenCalled();
    expect(cont.spy).not.toHaveBeenCalled();
    expect(stepEndsTurn(state.messages ?? [], 1)).toBe('task_recovery_failed');
  });

  it('Test D — set_order_line_quantity con returnDirect sigue terminando el grafo igual', async () => {
    const model = new ScriptedChatModel([
      aiCall('set_order_line_quantity', { quantity: 3 }),
      new AIMessage('no debería llamarse'),
    ]);
    const persisted = { success: true, effect: { kind: 'order_line_quantity_persisted', reference: ORDER_LINE_ID } };
    const setQuantity = fakeTool('set_order_line_quantity', [persisted], { returnDirect: true });

    const state = await runAgentUntilUserInput(
      buildAgent(model, [setQuantity.tool]) as never,
      userTurn('3'),
      { recursionLimit: 12 }
    );

    expect(model.calls).toBe(1);
    expect(setQuantity.spy).toHaveBeenCalledWith(expect.objectContaining({ quantity: 3 }));
    expect(lastPayload(state)).toEqual(persisted);
  });
});
