/**
 * Tests de integración para runHybridReactAgent.
 *
 * CTA: el agente pide `present_product_cta` (signal). Ya no corre ctaPlanner post-proceso.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIMessage, ToolMessage } from '@langchain/core/messages';

vi.mock('@langchain/langgraph/prebuilt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@langchain/langgraph/prebuilt')>();
  return { ...actual, createReactAgent: vi.fn() };
});

vi.mock('../../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/env')>();
  return {
    ...actual,
    isHybridCtaEnabled: vi.fn(() => false),
    isHybridCtaEnabledForBusiness: vi.fn(() => false),
    getHybridCtaTargetIntents: vi.fn(() => new Set(['PRODUCT_ATTRIBUTE_QUESTION', 'PRODUCT_QUERY'])),
    isDryRunWhatsAppSend: vi.fn(() => false),
  };
});

vi.mock('../ctaPlanner', () => ({
  planCta: vi.fn(),
}));

vi.mock('../ctaResolver', () => ({
  resolveCta: vi.fn(),
  hasLexicalBuySignal: vi.fn(() => false),
}));

vi.mock('../../whatsappBuilders/hybridCta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../whatsappBuilders/hybridCta')>();
  return {
    ...actual,
    buildHybridCtaInteractive: vi.fn(),
    extractPrimaryPayload: vi.fn(() => 'ADD_ITEM:prod-1:1'),
    extractPrimaryProductId: vi.fn(() => 'prod-1'),
  };
});

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  findOrCreateConversationState: vi.fn(),
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: { searchMenuItemsByKeyword: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../config/llm', () => ({
  getHybridReasonerLlm: vi.fn(() => ({})),
}));

vi.mock('../../services/botPersonality.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/botPersonality.service')>();
  return {
    ...actual,
    resolvePersonalityForBusiness: vi.fn().mockResolvedValue({
      id: 'personality-1',
      promptText: 'test personality',
    }),
  };
});

vi.mock('../contextMessage', () => ({
  buildContextMessage: vi.fn().mockResolvedValue('ctx'),
}));

vi.mock('../conversationHistory', () => ({
  buildAgentHistoryMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([]),
    menu_item: {
      findFirst: vi.fn().mockResolvedValue({ id: 'prod-1', name: 'Ceviche Clásico' }),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue({ name: 'Ceviche Clásico' }),
    },
    draft_order: {
      findFirst: vi.fn().mockResolvedValue(null),
    },
  },
}));

vi.mock('../../services/category.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/category.service')>();
  return {
    ...actual,
    buildCategoryProductListMessage: vi.fn(),
  };
});

vi.mock('../../services/cart.service', () => ({
  buildCartSummaryMessage: vi.fn().mockResolvedValue({
    type: 'list',
    header: { type: 'text', text: '🤖\n\n*Tu pedido actual* 🛒' },
    body: { text: '*Platos principales*\n1× Papas a la huancaína' },
    footer: { text: 'Elegí o escribí' },
    action: { button: 'Ver opciones', sections: [] },
  }),
}));

import { runHybridReactAgent, resetAgentCacheForTesting } from '../reactAgent';
import type { HybridAgentRunResult } from '../reactAgent';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { isHybridCtaEnabled, isHybridCtaEnabledForBusiness } from '../../config/env';
import { planCta } from '../ctaPlanner';
import { resolveCta } from '../ctaResolver';
import {
  buildHybridCtaInteractive,
  extractPrimaryProductId,
} from '../../whatsappBuilders/hybridCta';
import { findOrCreateConversationState, patchConversationMetadata } from '../../repositories';
import { getHybridReasonerLlm } from '../../config/llm';
import * as complementSuggestions from '../../services/complementSuggestions.service';
import { prisma } from '../../lib/prisma';
import { buildCategoryProductListMessage } from '../../services/category.service';
import { HumanIntentToolNode } from '../humanIntentToolNode';
import { buildCartSummaryMessage } from '../../services/cart.service';
import { setOrderLineQuantityTool } from '../../tools';

/**
 * Double del grafo: runHybridReactAgent consume `stream` (modo values); el
 * double deriva un único estado final de su `invoke`, igual que el grafo real.
 */
const mockAgent = (agent: { invoke: (...args: any[]) => Promise<unknown> }) =>
  vi.mocked(createReactAgent).mockReturnValue({
    ...agent,
    stream: async (input: unknown, options: unknown) => {
      const state = await agent.invoke(input, options);
      return (async function* () {
        yield state;
      })();
    },
  } as any);

const BOT_TEXT = '🤖\n\n*Ceviche Clásico* 🐟\n\nEs levemente picante.';

const unwrap = (result: HybridAgentRunResult | null) =>
  result?.kind === 'response' ? result.handlerResult : null;

const makeAgentInvoke = (text: string) =>
  vi.fn().mockResolvedValue({
    messages: [{ content: text }],
  });

const makeAgentInvokeWithProductSearch = (
  text: string,
  items: Array<{ id: string; name: string; price?: { amount: string; currency: string } }>
) =>
  vi.fn().mockResolvedValue({
    messages: [
      {
        tool_call_id: 'tc-search-1',
        name: 'search_products',
        content: JSON.stringify({ count: items.length, items }),
      },
      { content: text },
    ],
  });

const makeAgentInvokeWithPresentCta = (
  text: string,
  cta: Record<string, unknown>
) =>
  vi.fn().mockResolvedValue({
    messages: [
      {
        tool_call_id: 'tc-cta-1',
        name: 'present_product_cta',
        content: JSON.stringify({ signal: 'present_product_cta', ...cta }),
      },
      { content: text },
    ],
  });

const makeAgentInvokeWithNote = (text: string) =>
  vi.fn().mockResolvedValue({
    messages: [
      {
        tool_call_id: 'tc-note-1',
        name: 'update_item_note',
        content: JSON.stringify({ success: true, itemName: 'Lomo saltado', note: 'poca sal' }),
      },
      { content: text },
    ],
  });

const makeCtx = (overrides: Record<string, unknown> = {}) => ({
  business: { id: 'biz-1', currency_code: 'PEN' },
  customer: { id: 'cust-1', phone_number: '51999000000' },
  conversation: { id: 'conv-1', started_at: new Date(), lastReferencedProductId: null },
  conversationState: { metadata: {} },
  conversationId: 'conv-1',
  message: { text: { body: 'el ceviche puede ser picante?' }, type: 'text' },
  to: '51999000000',
  payloadId: undefined,
  payload: {},
  phoneNumberId: 'ph-1',
  value: {},
  detection: {
    intent: 'PRODUCT_ATTRIBUTE_QUESTION',
    confidence: 0.85,
    detectedProductName: 'ceviche',
    quantity: null,
    candidates: [],
    raw: null,
  },
  ...overrides,
});

describe('runHybridReactAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentCacheForTesting();
    mockAgent({
      invoke: makeAgentInvoke(BOT_TEXT),
    } as any);
  });

  it.each(['3', 'Para 3', 'Somos tres'])(
    'fuerza save_party_size para "%s" solo en la llamada inicial',
    async (text) => {
      const bindTools = vi.fn().mockReturnValue({ invoke: vi.fn() });
      vi.mocked(getHybridReasonerLlm).mockReturnValue({ bindTools } as never);

      await runHybridReactAgent(
        makeCtx({
          message: { text: { body: text } },
          activeBlockingGoal: 'OBTENER_PERSONAS_DEL_PEDIDO',
          goalFulfillmentCandidate: { goalType: 'OBTENER_PERSONAS_DEL_PEDIDO' },
        }) as any
      );

      const createCalls = vi.mocked(createReactAgent).mock.calls;
      const createArgs = createCalls[createCalls.length - 1]?.[0] as any;
      expect(typeof createArgs.llm).toBe('function');
      createArgs.llm({ messages: [{ _getType: () => 'human' }] });
      createArgs.llm({ messages: [{ _getType: () => 'tool' }] });

      expect(bindTools).toHaveBeenNthCalledWith(
        1,
        expect.arrayContaining([expect.objectContaining({ name: 'save_party_size' })]),
        expect.objectContaining({
          parallel_tool_calls: false,
          tool_choice: 'save_party_size',
        })
      );
      expect(bindTools).toHaveBeenNthCalledWith(
        2,
        expect.any(Array),
        { parallel_tool_calls: true }
      );
    }
  );

  it('expone solo quantity y vincula el fulfillment al target estructurado', async () => {
    const bindTools = vi.fn((tools) => tools);
    vi.mocked(getHybridReasonerLlm).mockReturnValue({ bindTools } as never);
    const target = { orderLineId: 'line-papas', hint: 'papas' };
    await runHybridReactAgent(makeCtx({
      activeBlockingGoal: 'OBTENER_CANTIDAD_DEL_PRODUCTO',
      goalFulfillmentCandidate: {
        goalType: 'OBTENER_CANTIDAD_DEL_PRODUCTO',
        target,
      },
    }) as any);

    const createCalls = vi.mocked(createReactAgent).mock.calls;
    const createArgs = createCalls[createCalls.length - 1]?.[0] as any;
    const modelTools = createArgs.llm({ messages: [{ _getType: () => 'human' }] });
    expect(bindTools).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      parallel_tool_calls: false,
      tool_choice: 'set_order_line_quantity',
    }));
    const quantityTool = modelTools.find((tool: { name: string }) => tool.name === 'set_order_line_quantity');
    expect(Object.keys(quantityTool.schema.shape)).toEqual(['quantity']);
    // Test H: persistir la cantidad no termina el grafo y el tool_choice queda libre después.
    expect((quantityTool as { returnDirect?: boolean }).returnDirect).toBeFalsy();
    createArgs.llm({ messages: [{ _getType: () => 'tool' }] });
    expect(bindTools).toHaveBeenLastCalledWith(expect.any(Array), { parallel_tool_calls: true });

    const invokeSpy = vi.spyOn(setOrderLineQuantityTool, 'invoke').mockResolvedValue('persisted' as never);
    await quantityTool.invoke({ quantity: 3 }, {
      configurable: { goalFulfillmentCandidate: { goalType: 'OBTENER_CANTIDAD_DEL_PRODUCTO', target } },
    });
    expect(invokeSpy).toHaveBeenCalledWith(
      { orderLineId: 'line-papas', quantity: 3 },
      expect.objectContaining({ configurable: expect.objectContaining({ goalFulfillmentCandidate: expect.any(Object) }) })
    );
    invokeSpy.mockRestore();
  });

  it('mantiene el binding estático sin candidate, con Goal activo o sin Goal', async () => {
    const bindTools = vi.fn().mockReturnValue({ invoke: vi.fn() });
    vi.mocked(getHybridReasonerLlm).mockReturnValue({ bindTools } as never);

    await runHybridReactAgent(
      makeCtx({ activeBlockingGoal: 'OBTENER_PERSONAS_DEL_PEDIDO' }) as any
    );
    let createCalls = vi.mocked(createReactAgent).mock.calls;
    let createArgs = createCalls[createCalls.length - 1]?.[0] as any;
    expect(typeof createArgs.llm).not.toBe('function');
    expect(bindTools.mock.calls[0]?.[1]).toEqual({ parallel_tool_calls: true });

    resetAgentCacheForTesting();
    bindTools.mockClear();
    await runHybridReactAgent(makeCtx({ message: { text: { body: '3' } } }) as any);
    createCalls = vi.mocked(createReactAgent).mock.calls;
    createArgs = createCalls[createCalls.length - 1]?.[0] as any;
    expect(typeof createArgs.llm).not.toBe('function');
    expect(bindTools.mock.calls[0]?.[1]).toEqual({ parallel_tool_calls: true });
  });

  it('sin present_product_cta → texto plano y planCta no corre', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result).not.toBeNull();
    expect(result!.isInteractive).toBe(false);
    expect(typeof result!.content).toBe('string');
    expect(planCta).not.toHaveBeenCalled();
    expect(buildHybridCtaInteractive).not.toHaveBeenCalled();
  });

  describe('precedencia de respuesta terminal: askMessage posterior gana a señales de presentación previas', () => {
    const toolMessage = (name: string, content: Record<string, unknown>, id = `tc-${name}-${Math.random()}`) => ({
      tool_call_id: id,
      name,
      content: JSON.stringify(content),
    });
    // Separador de iteración (sin tool_call_id → messageRole lo clasifica 'assistant'), para que
    // cada ToolMessage simule su propio step de ReAct, igual que en una corrida real con varias
    // idas y vueltas al modelo. Sin esto, lastStepToolPayloads trataría todos los tool messages
    // como un único step y el efecto exitoso más antiguo taparía el askMessage más reciente.
    const step = () => ({});
    const quantityRequiredAsk = '¿Cuántas unidades de Papa a la huancaina querés agregar?';

    it('TEST A — askMessage posterior a present_cart_signal gana: no se envía el resumen del carrito', async () => {
      // Reproduce el caso real: update_cart_item_quantity (→ present_cart_signal) + continue_order_line,
      // ambos exitosos, seguidos por add_cart_item que todavía necesita la cantidad.
      mockAgent({ invoke: vi.fn().mockResolvedValue({
        messages: [
          step(),
          toolMessage('update_cart_item_quantity', { success: true, effect: { kind: 'cart_quantity_persisted' }, followUp: { nextAction: 'present_cart' } }),
          step(),
          toolMessage('continue_order_line', { success: true, effect: { kind: 'order_plan_advanced' }, activeLine: { hint: 'papas a la huancaína' } }),
          step(),
          toolMessage('search_products', { count: 1, items: [{ id: 'papas-1' }] }),
          step(),
          toolMessage('resolve_product', { success: true, orderLineId: 'line-papas', currentResolutionId: 'res-papas' }),
          step(),
          toolMessage('add_cart_item', { success: false, error: 'order_line_quantity_required', askMessage: quantityRequiredAsk }),
        ],
      }) });

      const result = unwrap(await runHybridReactAgent(makeCtx({ message: { text: { body: 'Sí' } } }) as any));
      const visible = JSON.stringify(result?.content ?? '');

      expect(visible).toContain(quantityRequiredAsk);
      expect(buildCartSummaryMessage).not.toHaveBeenCalled();
      expect(visible).not.toMatch(/Ceviche Clásico|Total:/);
    });

    it('TEST B — askMessage sin present_cart previo sigue funcionando igual que antes', async () => {
      mockAgent({ invoke: vi.fn().mockResolvedValue({
        messages: [toolMessage('add_cart_item', { success: false, error: 'order_line_quantity_required', askMessage: quantityRequiredAsk })],
      }) });

      const result = unwrap(await runHybridReactAgent(makeCtx() as any));
      const visible = JSON.stringify(result?.content ?? '');

      expect(visible).toContain(quantityRequiredAsk);
      expect(buildCartSummaryMessage).not.toHaveBeenCalled();
    });

    it('TEST C — present_cart sin askMessage posterior: sigue mostrando el carrito (sin regresión)', async () => {
      mockAgent({ invoke: vi.fn().mockResolvedValue({
        messages: [toolMessage('update_cart_item_quantity', { success: true, effect: { kind: 'cart_quantity_persisted' }, followUp: { nextAction: 'present_cart' } })],
      }) });

      await runHybridReactAgent(makeCtx() as any);

      expect(buildCartSummaryMessage).toHaveBeenCalled();
    });

    it('TEST E — la precedencia no depende de present_cart específicamente: otras señales de éxito tampoco tapan el askMessage', async () => {
      // tool A y tool B no tocan presentCart/cartMutatedThisTurn ni add_cart_item en absoluto.
      mockAgent({ invoke: vi.fn().mockResolvedValue({
        messages: [
          step(),
          toolMessage('save_party_size', { success: true, effect: { kind: 'party_size_persisted' }, partySize: 3 }),
          step(),
          toolMessage('set_order_line_quantity', {
            success: true,
            effect: { kind: 'order_line_quantity_persisted' },
            orderLine: { id: 'line-ceviche', hint: 'ceviche', requestedQuantity: 2 },
          }),
          step(),
          toolMessage('add_cart_item', { success: false, error: 'order_line_quantity_required', askMessage: quantityRequiredAsk }),
        ],
      }) });

      const result = unwrap(await runHybridReactAgent(makeCtx() as any));
      const visible = JSON.stringify(result?.content ?? '');

      expect(visible).toContain(quantityRequiredAsk);
      expect(buildCartSummaryMessage).not.toHaveBeenCalled();
    });

    it('TEST F — ninguna confirmación falsa ("Cantidad anotada", "Listo", "Agregado") acompaña al askMessage', async () => {
      mockAgent({ invoke: vi.fn().mockResolvedValue({
        messages: [
          step(),
          toolMessage('update_cart_item_quantity', { success: true, effect: { kind: 'cart_quantity_persisted' }, followUp: { nextAction: 'present_cart' } }),
          step(),
          toolMessage('set_order_line_quantity', {
            success: true,
            effect: { kind: 'order_line_quantity_persisted' },
            orderLine: { id: 'line-ceviche', hint: 'ceviche', requestedQuantity: 2 },
          }),
          step(),
          toolMessage('add_cart_item', { success: false, error: 'order_line_quantity_required', askMessage: quantityRequiredAsk }),
        ],
      }) });

      const result = unwrap(await runHybridReactAgent(makeCtx() as any));
      const visible = JSON.stringify(result?.content ?? '');

      expect(visible).toContain(quantityRequiredAsk);
      expect(visible).not.toMatch(/Cantidad anotada|Cambio guardado|Carrito actualizado/i);
      // "Listo"/"Agregado" no aparecen salvo que sean parte del propio askMessage (no lo son acá).
      const withoutAsk = visible.replace(quantityRequiredAsk, '');
      expect(withoutAsk).not.toMatch(/Listo|Agregado/i);
    });
  });

  describe('queueFollowUp del add_cart_item llega a la respuesta final (sin ejecutar la siguiente línea)', () => {
    const addToolMessage = (queueFollowUp?: { nextHint: string; remaining: number }) => ({
      tool_call_id: 'tc-add',
      name: 'add_cart_item',
      content: JSON.stringify({
        success: true,
        effect: { kind: 'cart_item_persisted', reference: 'ceviche-1' },
        closedOrderLine: { id: 'line-ceviche', status: 'done' },
        added: { productId: 'ceviche-1', itemName: 'Ceviche Clásico', quantity: 2 },
        ...(queueFollowUp ? { queueFollowUp } : {}),
      }),
    });

    it('TEST A/C — cola con 2 líneas pendientes: la respuesta nombra nextHint, sin tool para la siguiente línea', async () => {
      mockAgent({ invoke: vi.fn().mockResolvedValue({
        messages: [addToolMessage({ nextHint: 'papas a la huancaína', remaining: 2 })],
      }) });

      const result = unwrap(await runHybridReactAgent(makeCtx() as any));
      const visible = JSON.stringify(result?.content ?? '');

      // El CTA (dato determinístico del add_cart_item, no inferencia) llega al cuerpo del
      // resumen; nunca por llmProse (eso lo antepondría, no lo pondría al final).
      expect(buildCartSummaryMessage).toHaveBeenCalledWith(expect.objectContaining({ llmProse: null }));
      expect(visible).toMatch(/papas a la huancaína/);
      expect(visible).toMatch(/Quedan 2 línea\(s\)/);
      // Ninguna tool se ejecutó para la siguiente línea: el mock de invoke solo devolvió el
      // ToolMessage de add_cart_item, sin search_products/resolve_product/present_product_cta/continue_order_line.
      expect(visible).not.toMatch(/search_products|resolve_product|present_product_cta|continue_order_line/);
    });

    it('TEST B — sin cola restante: comportamiento actual (llmProse: null), sin "¿algo más?" artificial', async () => {
      mockAgent({ invoke: vi.fn().mockResolvedValue({ messages: [addToolMessage(undefined)] }) });

      const result = unwrap(await runHybridReactAgent(makeCtx() as any));
      const visible = JSON.stringify(result?.content ?? '');

      expect(buildCartSummaryMessage).toHaveBeenCalledWith(expect.objectContaining({ llmProse: null }));
      expect(visible).not.toMatch(/algo más/i);
      expect(visible).not.toMatch(/Quedan|Queda \d/);
    });

    it('no ofrece seguir si remaining llega en 0 (cola ya cerrada del todo)', async () => {
      mockAgent({ invoke: vi.fn().mockResolvedValue({
        messages: [addToolMessage({ nextHint: 'papas a la huancaína', remaining: 0 })],
      }) });

      const result = unwrap(await runHybridReactAgent(makeCtx() as any));
      const visible = JSON.stringify(result?.content ?? '');

      expect(buildCartSummaryMessage).toHaveBeenCalledWith(expect.objectContaining({ llmProse: null }));
      expect(visible).not.toMatch(/Quedan|Queda \d/);
    });

    it('TEST 1 — el queueFollowUp queda DESPUÉS del resumen del carrito (orden, no solo presencia)', async () => {
      mockAgent({ invoke: vi.fn().mockResolvedValue({
        messages: [addToolMessage({ nextHint: 'papas a la huancaína', remaining: 2 })],
      }) });

      const result = unwrap(await runHybridReactAgent(makeCtx() as any)) as { content: { body: { text: string } } };
      const bodyText = result.content.body.text;

      const cartIndex = bodyText.indexOf('Platos principales');
      const followUpIndex = bodyText.indexOf('Quedan 2 línea(s)');
      expect(cartIndex).toBeGreaterThanOrEqual(0);
      expect(followUpIndex).toBeGreaterThan(cartIndex);
      // El CTA es literalmente el cierre del mensaje: no hay nada después.
      expect(bodyText.endsWith('¿Seguimos con *papas a la huancaína*?')).toBe(true);
    });

    it('TEST 3 — sin queueFollowUp, el body del carrito queda exactamente igual que antes', async () => {
      mockAgent({ invoke: vi.fn().mockResolvedValue({ messages: [addToolMessage(undefined)] }) });

      const result = unwrap(await runHybridReactAgent(makeCtx() as any)) as { content: { body: { text: string } } };

      expect(result.content.body.text).toBe('*Platos principales*\n1× Papas a la huancaína');
    });

    it('TEST 4 — singular: "Queda 1 línea" (sin "(s)", sin "Quedan"), al final del mensaje', async () => {
      mockAgent({ invoke: vi.fn().mockResolvedValue({
        messages: [addToolMessage({ nextHint: 'chicha morada', remaining: 1 })],
      }) });

      const result = unwrap(await runHybridReactAgent(makeCtx() as any)) as { content: { body: { text: string } } };
      const bodyText = result.content.body.text;

      expect(bodyText.endsWith('Queda 1 línea de tu pedido por sumar. ¿Seguimos con *chicha morada*?')).toBe(true);
      expect(bodyText).not.toMatch(/Quedan|línea\(s\)/);
    });

    it('TEST 5 — plural: "Quedan 2 línea(s)", al final del mensaje', async () => {
      mockAgent({ invoke: vi.fn().mockResolvedValue({
        messages: [addToolMessage({ nextHint: 'papas a la huancaína', remaining: 2 })],
      }) });

      const result = unwrap(await runHybridReactAgent(makeCtx() as any)) as { content: { body: { text: string } } };
      const bodyText = result.content.body.text;

      expect(bodyText.endsWith('Quedan 2 línea(s) de tu pedido por sumar. ¿Seguimos con *papas a la huancaína*?')).toBe(true);
    });

    it('TEST 6 — construir el mensaje es pura composición de texto: no vuelve a invocar al agente', async () => {
      // El reordenamiento es composición de respuesta después de que el grafo ya terminó
      // (agent.stream/invoke no se vuelve a llamar). La garantía fuerte de que ningún tool
      // corre automáticamente tras el fulfillment ya está en turnAwaitsUserInput.test.ts
      // (TEST 5, sobre el grafo real) y no cambia con este ajuste puramente visual.
      const invoke = vi.fn().mockResolvedValue({
        messages: [addToolMessage({ nextHint: 'papas a la huancaína', remaining: 2 })],
      });
      mockAgent({ invoke });

      await runHybridReactAgent(makeCtx() as any);

      expect(invoke).toHaveBeenCalledTimes(1);
    });
  });

  it('usa la cantidad persistida y no la prosa del modelo después de un add exitoso', async () => {
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            tool_calls: [{
              id: 'tc-add',
              name: 'add_cart_item',
              args: { productId: 'papa-1', quantity: 2 },
            }],
          },
          {
            tool_call_id: 'tc-add',
            name: 'add_cart_item',
            content: JSON.stringify({
              success: true,
              effect: { kind: 'cart_item_persisted', reference: 'papa-1' },
              added: { productId: 'papa-1', quantity: 1 },
            }),
          },
          { content: 'Te confirmo dos papas a la huancaína.' },
        ],
      }),
    } as any);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result?.isInteractive).toBe(true);
    expect(result?.content).toMatchObject({
      body: { text: expect.stringContaining('1× Papas a la huancaína') },
    });
    expect(result?.content).not.toMatchObject({
      body: { text: expect.stringContaining('dos papas') },
    });
    expect(buildCartSummaryMessage).toHaveBeenCalledWith(
      expect.objectContaining({ llmProse: null })
    );
  });

  it('procesa el efecto de un ToolMessage aunque falte tool_call_id', async () => {
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            name: 'add_cart_item',
            content: JSON.stringify({
              success: true,
              effect: { kind: 'cart_item_persisted', reference: 'papa-1' },
              added: { productId: 'papa-1', quantity: 1 },
            }),
          },
        ],
      }),
    } as any);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result?.content).toMatchObject({
      body: { text: expect.stringContaining('1× Papas a la huancaína') },
    });
    expect(buildCartSummaryMessage).toHaveBeenCalledWith(
      expect.objectContaining({ llmProse: null })
    );
  });

  it('no afirma agregado cuando add_cart_item no devuelve success', async () => {
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            tool_call_id: 'tc-add',
            name: 'add_cart_item',
            content: JSON.stringify({ success: false, error: 'product_not_found' }),
          },
          { content: 'Listo, te agregué dos papas.' },
        ],
      }),
    } as any);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result?.content).toMatch(/no pude confirmar/i);
    expect(result?.content).not.toMatch(/(sumé|agregué|tenés|te confirmo)/i);
    expect(buildCartSummaryMessage).not.toHaveBeenCalled();
  });

  it('success ausente se trata como desconocido, nunca como mutación exitosa', async () => {
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            tool_call_id: 'tc-add-unknown',
            name: 'add_cart_item',
            content: JSON.stringify({ success: null, error: 'unknown_result' }),
          },
        ],
      }),
    } as any);

    const result = await runHybridReactAgent(makeCtx() as any);

    expect(result).toBeNull();
    expect(buildCartSummaryMessage).not.toHaveBeenCalled();
  });

  it('la traza conserva count=3 de save_party_size y separa call de resultado', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            tool_calls: [{ id: 'tc-party', name: 'save_party_size', args: { count: 3 } }],
          },
          {
            tool_call_id: 'tc-party',
            name: 'save_party_size',
            status: 'success',
            content: JSON.stringify({
              success: true,
              effect: { kind: 'party_size_persisted' },
              partySize: 3,
            }),
          },
        ],
      }),
    } as any);

    try {
      await runHybridReactAgent(makeCtx() as any);
      expect(debug).toHaveBeenCalledWith(expect.stringContaining('"count":3'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"event":"[tool]"'));
      expect(info).toHaveBeenCalledWith(expect.stringContaining('"success":true'));
    } finally {
      debug.mockRestore();
      info.mockRestore();
    }
  });

  it('prioriza el AI terminal y la presentación tras save_party_size exitoso', async () => {
    const productA = '11111111-1111-4111-8111-111111111111';
    const productB = '22222222-2222-4222-8222-222222222222';
    const terminalText =
      '🤖\n\n*Elegí el ceviche* 🐟\n\nTenés dos opciones. Decime cuál preferís.';
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);
    vi.mocked(prisma.menu_item.findMany).mockResolvedValue([
      { id: productA, name: 'Ceviche Clásico', description: null, menu_item_price: [{ amount: 100 }] },
      { id: productB, name: 'Ceviche clásico con variaciones', description: null, menu_item_price: [{ amount: 25000 }] },
    ] as any);
    vi.mocked(buildHybridCtaInteractive).mockImplementation((bodyText) => ({
      content: bodyText,
      isInteractive: false,
    }) as any);
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            tool_calls: [{ id: 'tc-party', name: 'save_party_size', args: { count: 4 } }],
          },
          {
            tool_call_id: 'tc-party',
            name: 'save_party_size',
            status: 'success',
            content: JSON.stringify({
              success: true,
              effect: { kind: 'party_size_persisted' },
              partySize: 4,
            }),
          },
          {
            tool_calls: [{ id: 'tc-search', name: 'search_products', args: { keyword: 'ceviche' } }],
          },
          {
            tool_call_id: 'tc-search',
            name: 'search_products',
            status: 'success',
            content: JSON.stringify({ count: 2, items: [{ id: productA }, { id: productB }] }),
          },
          {
            tool_calls: [{
              id: 'tc-cta',
              name: 'present_product_cta',
              args: { primaryKind: 'SELECT_FROM_LIST', productIds: [productA, productB] },
            }],
          },
          {
            tool_call_id: 'tc-cta',
            name: 'present_product_cta',
            status: 'success',
            content: JSON.stringify({
              signal: 'present_product_cta',
              primaryKind: 'SELECT_FROM_LIST',
              productIds: [productA, productB],
              primaryLabel: null,
            }),
          },
          { content: terminalText },
        ],
      }),
    } as any);

    const result = unwrap(await runHybridReactAgent(makeCtx({
      activeBlockingGoal: 'OBTENER_PERSONAS_DEL_PEDIDO',
      goalFulfillmentCandidate: { goalType: 'OBTENER_PERSONAS_DEL_PEDIDO' },
    }) as any));

    expect(result?.content).toBe(terminalText);
    expect(String(result?.content)).not.toContain('El cambio quedó guardado.');
    expect(buildHybridCtaInteractive).toHaveBeenCalledWith(
      terminalText,
      expect.objectContaining({ primary: expect.objectContaining({ kind: 'SELECT_FROM_LIST' }) })
    );
  });

  it('usa la confirmación de successfulEffectCount solo si no hay texto terminal', async () => {
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          { tool_calls: [{ id: 'tc-party', name: 'save_party_size', args: { count: 4 } }] },
          {
            tool_call_id: 'tc-party',
            name: 'save_party_size',
            status: 'success',
            content: JSON.stringify({ success: true, effect: { kind: 'party_size_persisted' } }),
          },
          { content: '' },
        ],
      }),
    } as any);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result?.content).toContain('El cambio quedó guardado.');
  });

  it('instala el gate central y propaga la revision solo cuando viene del preflight', async () => {
    await runHybridReactAgent(
      makeCtx({
        conversationState: {
          metadata: {
            humanIntentState: {
              version: 1,
              revision: 7,
              nextSequence: 2,
              processedMessageIds: ['wamid-1'],
              records: [],
            },
          },
        },
        humanIntentGateRevision: 7,
      }) as any
    );

    const args = vi.mocked(createReactAgent).mock.calls[0][0];
    expect(args.tools).toBeInstanceOf(HumanIntentToolNode);
    const agent = vi.mocked(createReactAgent).mock.results[0].value as unknown as {
      invoke: ReturnType<typeof vi.fn>;
    };
    expect(agent.invoke.mock.calls[0][1].configurable.humanIntentGateRevision).toBe(7);
  });

  it('present_product_cta ADD_ITEM con productId → interactive sin planCta', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);
    mockAgent({
      invoke: makeAgentInvokeWithPresentCta(BOT_TEXT, {
        primaryKind: 'ADD_ITEM',
        productId: 'prod-1',
        productHint: 'ceviche',
        quantity: 1,
        primaryLabel: 'Agregar 🛒',
        secondaryKind: 'VIEW_FEATURED',
        secondaryLabel: 'Ver destacados',
      }),
    } as any);
    vi.mocked(buildHybridCtaInteractive).mockReturnValue({
      content: { type: 'interactive', interactive: {} },
      isInteractive: true,
    });

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result!.isInteractive).toBe(true);
    expect(planCta).not.toHaveBeenCalled();
    expect(resolveCta).not.toHaveBeenCalled();
    expect(buildHybridCtaInteractive).toHaveBeenCalledOnce();
    expect(patchConversationMetadata).toHaveBeenCalledOnce();
  });

  it('present_product_cta SELECT_FROM_LIST con productHints → resolveCta + interactive', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);
    mockAgent({
      invoke: makeAgentInvokeWithPresentCta(BOT_TEXT, {
        primaryKind: 'SELECT_FROM_LIST',
        productHints: ['Ceviche clásico', 'Ceviche mixto'],
        primaryLabel: 'Elegir uno',
        secondaryKind: 'VIEW_MENU',
        secondaryLabel: 'Ver menú',
      }),
    } as any);
    vi.mocked(resolveCta).mockResolvedValue({
      primary: {
        kind: 'SELECT_FROM_LIST',
        candidates: [
          { productId: 'a', title: 'Ceviche clásico' },
          { productId: 'b', title: 'Ceviche mixto' },
        ],
        bodyText: BOT_TEXT,
      },
      secondary: { kind: 'VIEW_MENU', label: 'Ver menú' },
    });
    vi.mocked(buildHybridCtaInteractive).mockReturnValue({
      content: { type: 'list' },
      isInteractive: true,
    });

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result!.isInteractive).toBe(true);
    expect(planCta).not.toHaveBeenCalled();
    expect(resolveCta).toHaveBeenCalledOnce();
  });

  it('present_product_cta SELECT_FROM_LIST con productIds → lista única sin resolveCta', async () => {
    const idA = '11111111-1111-1111-1111-111111111111';
    const idB = '22222222-2222-2222-2222-222222222222';
    const introText =
      '🤖\n\n*Opciones* 🍽️\n\n¡Qué buena idea! Hay varias pizzanesas que te pueden gustar.';

    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);
    vi.mocked(prisma.menu_item.findMany).mockResolvedValue([
      {
        id: idA,
        name: 'Pizzanesa Napolitana',
        description: null,
        menu_item_price: [{ amount: 1200 }],
      },
      {
        id: idB,
        name: 'Pizzanesa Fugazzeta',
        description: null,
        menu_item_price: [{ amount: 1300 }],
      },
    ] as any);
    mockAgent({
      invoke: makeAgentInvokeWithPresentCta(introText, {
        primaryKind: 'SELECT_FROM_LIST',
        productIds: [idA, idB],
        primaryLabel: 'Elegí el ceviche que querés',
        secondaryKind: 'VIEW_MENU',
        secondaryLabel: 'Ver menú',
      }),
    } as any);
    vi.mocked(buildHybridCtaInteractive).mockReturnValue({
      content: { type: 'list' },
      isInteractive: true,
    });
    vi.mocked(extractPrimaryProductId).mockReturnValue(null);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result!.isInteractive).toBe(true);
    expect(result!.followUps).toBeUndefined();
    expect(planCta).not.toHaveBeenCalled();
    expect(resolveCta).not.toHaveBeenCalled();
    expect(buildHybridCtaInteractive).toHaveBeenCalledOnce();
    const planArg = vi.mocked(buildHybridCtaInteractive).mock.calls[0][1];
    expect(planArg.primary.kind).toBe('SELECT_FROM_LIST');
    if (planArg.primary.kind === 'SELECT_FROM_LIST') {
      expect(planArg.primary.candidates.map((c) => c.productId)).toEqual([idA, idB]);
      expect(planArg.primary.bodyText).toContain('pizzanesas');
    }
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        pendingProductSelection: true,
        candidateProductIds: [idA, idB],
      })
    );
  });

  it('update_item_note sin present_product_cta → texto solo (caso poca sal)', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);
    mockAgent({
      invoke: makeAgentInvokeWithNote(
        '🤖\n\n*Respuesta* 💬\n\n¡Anotado! El lomo va con poca sal.'
      ),
    } as any);

    const result = unwrap(
      await runHybridReactAgent(
        makeCtx({
          message: { text: { body: 'Quiero que tenga poca sal' }, type: 'text' },
        }) as any
      )
    );

    expect(result!.isInteractive).toBe(false);
    expect(planCta).not.toHaveBeenCalled();
    expect(buildHybridCtaInteractive).not.toHaveBeenCalled();
  });

  it('update_item_note exitoso → lista con guías de gestión', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      total_amount: 4100,
      fulfillment_type: null,
    } as never);
    mockAgent({
      invoke: makeAgentInvokeWithNote(
        '¡Listo! Anoté que el Lomo saltado es con poca sal y acá van unos platos.'
      ),
    } as any);

    const result = unwrap(
      await runHybridReactAgent(
        makeCtx({
          message: { text: { body: 'con poca sal' }, type: 'text' },
        }) as any
      )
    );

    expect(result!.isInteractive).toBe(true);
    const list = result!.content as { body: { text: string }; footer: { text: string } };
    expect(list.body.text).toContain('¡Listo! Anoté «poca sal» en Lomo saltado');
    expect(list.body.text).toMatch(/gestión de tu pedido/i);
    expect(list.body.text).toContain('• *Menú*');
    expect(list.body.text).toContain('• Ver *pedido*');
    expect(list.footer.text).toBe('Elegí o escribí');
    expect(list.body.text).not.toContain('acá van unos platos');
  });

  it('flag CTA off + present_product_cta → texto plano', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(false);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(false);
    mockAgent({
      invoke: makeAgentInvokeWithPresentCta(BOT_TEXT, {
        primaryKind: 'ADD_ITEM',
        productId: 'prod-1',
      }),
    } as any);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result!.isInteractive).toBe(false);
    expect(buildHybridCtaInteractive).not.toHaveBeenCalled();
  });

  it('agent sin texto útil → retorna null', async () => {
    mockAgent({
      invoke: vi.fn().mockResolvedValue({ messages: [] }),
    } as any);

    const result = await runHybridReactAgent(makeCtx() as any);
    expect(result).toBeNull();
  });

  it('present_category → lista de categoría sin present_product_cta', async () => {
    const categoryId = '33333333-3333-3333-3333-333333333333';
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            tool_call_id: 'tc-cat-1',
            name: 'present_category',
            content: JSON.stringify({ signal: 'present_category', categoryId }),
          },
          { content: 'te muestro las bebidas' },
        ],
      }),
    } as any);
    vi.mocked(buildCategoryProductListMessage).mockResolvedValue({
      message: {
        type: 'list',
        header: { type: 'text', text: '🤖\n\n*Bebidas frías* 🔎' },
        body: { text: 'Platillos de la categoría' },
        footer: { text: 'Elige un platillo' },
        action: { button: 'Ver platillos', sections: [] },
      },
      conversationUpdated: true,
    });

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result!.isInteractive).toBe(true);
    expect(buildCategoryProductListMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      categoryId,
      1,
      { bodyText: null }
    );
    expect(buildHybridCtaInteractive).not.toHaveBeenCalled();
  });

  it('shortlist de tools ≥2 sin present_product_cta → texto plano (sin lista automática)', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);

    const introText =
      '🤖\n\n*Opciones* 🍽️\n\n¡Qué buena idea! Hay varias pizzanesas que te pueden gustar.';
    mockAgent({
      invoke: makeAgentInvokeWithProductSearch(introText, [
        { id: 'prod-a', name: 'Pizzanesa Napolitana', price: { amount: '1200', currency: 'ARS' } },
        { id: 'prod-b', name: 'Pizzanesa Fugazzeta', price: { amount: '1300', currency: 'ARS' } },
      ]),
    } as any);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result!.isInteractive).toBe(false);
    expect(result!.followUps).toBeUndefined();
    expect(planCta).not.toHaveBeenCalled();
    expect(resolveCta).not.toHaveBeenCalled();
    expect(buildHybridCtaInteractive).not.toHaveBeenCalled();
    expect(prisma.menu_item.findMany).not.toHaveBeenCalled();
  });

  it('start_reservation_session → delegate_reservation (el nodo abre la sesión)', async () => {
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            tool_call_id: 'tc-res-1',
            name: 'start_reservation_session',
            content: JSON.stringify({
              signal: 'start_reservation_session',
              reason: 'quiere reservar una mesa',
            }),
          },
          { content: 'te paso con las reservas' },
        ],
      }),
    } as any);

    const result = await runHybridReactAgent(
      makeCtx({ message: { text: { body: 'quiero reservar una mesa' }, type: 'text' } }) as any
    );

    expect(result?.kind).toBe('delegate_reservation');
    if (result?.kind === 'delegate_reservation') {
      expect(result.reason).toBe('quiere reservar una mesa');
    }
  });

  it('request_human_support → responde el mensaje de derivación y no sigue conversando', async () => {
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            tool_call_id: 'tc-sup-1',
            name: 'request_human_support',
            content: JSON.stringify({
              signal: 'request_human_support',
              reason: 'pidió un asesor',
              message: 'derivado al equipo',
            }),
          },
          { content: '¿te ayudo con algo más mientras esperás?' },
        ],
      }),
    } as any);

    const result = await runHybridReactAgent(
      makeCtx({ message: { text: { body: 'me pasan con un asesor?' }, type: 'text' } }) as any
    );

    expect(result?.kind).toBe('response');
    expect(unwrap(result)!.content).toBe('derivado al equipo');
  });

  it('pending_cancel_disambiguation sin cancel_order → re-muestra botones (no prosa)', async () => {
    mockAgent({
      invoke: makeAgentInvoke(
        '🤖\n\nNo tenés un carrito activo 🛒\n\n¿Te gustaría ver el menú?'
      ),
    } as any);

    const result = unwrap(
      await runHybridReactAgent(
        makeCtx({
          message: { text: { body: 'Carrito' }, type: 'text' },
          conversationState: {
            metadata: {
              pending_cancel_disambiguation: {
                orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                orderRef: 'ABCD1234',
                askedAt: new Date().toISOString(),
              },
            },
          },
        }) as any
      )
    );

    expect(result!.isInteractive).toBe(true);
    expect(result!.content).toMatchObject({
      type: 'interactive',
      interactive: {
        type: 'button',
        action: {
          buttons: expect.arrayContaining([
            expect.objectContaining({
              reply: expect.objectContaining({ id: 'CANCEL_TARGET:draft' }),
            }),
            expect.objectContaining({
              reply: expect.objectContaining({ id: 'CANCEL_TARGET:order' }),
            }),
          ]),
        },
      },
    });
  });

  it('señal present_complement_suggestions no llega al body de WhatsApp y sí dispara la lista', async () => {
    const productId = '22a68a14-1111-4111-8111-111111111111';
    const signalPayload = {
      signal: 'present_complement_suggestions',
      productId,
    };
    const listBody = '¡Listo! Agregué 1 Arroz con leche.';
    const present = vi
      .spyOn(complementSuggestions, 'tryPresentComplementSuggestions')
      .mockResolvedValue({
        type: 'list',
        header: { type: 'text', text: '🤖\n\n*Para completar* 🍽️' },
        body: { text: listBody },
        footer: { text: 'Elegí o escribí' },
        action: { button: 'Ver sugerencias', sections: [] },
      });

    vi.mocked(findOrCreateConversationState).mockResolvedValue({ metadata: {} } as never);
    vi.mocked(prisma.draft_order.findFirst).mockResolvedValue({
      id: 'draft-1',
      draft_order_item: [{ product_id: productId }],
    } as never);
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            getType: () => 'human',
            content: 'ctx interno que no debe salir al cliente',
          },
          {
            getType: () => 'ai',
            content: '',
            tool_calls: [{ name: 'present_complement_suggestions' }],
          },
          {
            getType: () => 'tool',
            tool_call_id: 'tc-add-1',
            name: 'add_cart_item',
            content: JSON.stringify({ success: true }),
          },
          {
            getType: () => 'tool',
            tool_call_id: 'tc-comp-1',
            name: 'present_complement_suggestions',
            content: JSON.stringify(signalPayload),
          },
        ],
      }),
    } as any);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));
    const visible = JSON.stringify(result?.content ?? '');

    expect(present).toHaveBeenCalledOnce();
    expect(present.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        lastAddedMenuItemId: productId,
        draftOrderId: 'draft-1',
      })
    );
    expect(present.mock.calls[0][0].llmProse ?? '').not.toContain('present_complement_suggestions');
    expect(present.mock.calls[0][0].llmProse ?? '').not.toContain(productId);
    expect(present.mock.calls[0][0].llmProse ?? '').not.toContain('ctx interno');
    expect(result?.isInteractive).toBe(true);
    expect(visible).toContain(listBody);
    expect(visible).not.toContain('present_complement_suggestions');
    expect(visible).not.toContain('signal');
    expect(visible).not.toContain(productId);
    expect(visible).not.toContain('productId');
    present.mockRestore();
  });

  it('la prosa del asistente posterior a una tool sigue llegando a WhatsApp', async () => {
    const userFacing = '¡Listo! Agregué 1 Arroz con leche.';
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            tool_call_id: 'tc-info-1',
            name: 'get_business_hours',
            content: JSON.stringify({
              success: true,
              message: userFacing,
              internalTrace: 'HORARIO_INTERNO_NO_VISIBLE',
            }),
          },
          { content: userFacing },
        ],
      }),
    } as any);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));
    const visible = JSON.stringify(result?.content ?? '');

    expect(result?.isInteractive).toBe(false);
    expect(visible).toContain(userFacing);
    expect(visible).not.toContain('HORARIO_INTERNO_NO_VISIBLE');
    expect(visible).not.toContain('get_business_hours');
  });

  it('DEFER order_line_quantity_required corta el turno: responde el askMessage y no consume más pasos', async () => {
    const askMessage = '¿Cuántas unidades de Papa a la huancaina querés agregar?';
    const deferState = {
      messages: [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'tc-add', name: 'add_cart_item', args: { orderLineId: 'line-papas', productId: 'prod-1', resolutionId: 'res-1' }, type: 'tool_call' }],
        }),
        new ToolMessage({
          tool_call_id: 'tc-add',
          name: 'add_cart_item',
          content: JSON.stringify({ success: false, error: 'order_line_quantity_required', askMessage }),
        }),
      ],
    };
    const laterState = {
      messages: [
        ...deferState.messages,
        new ToolMessage({
          tool_call_id: 'tc-qty',
          name: 'set_order_line_quantity',
          content: JSON.stringify({
            success: true,
            effect: { kind: 'order_line_quantity_persisted', reference: 'line-papas' },
            orderLine: { id: 'line-papas', hint: 'papas', requestedQuantity: 2, status: 'active' },
          }),
        }),
      ],
    };
    const consumed: string[] = [];
    const cancel = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createReactAgent).mockReturnValue({
      stream: vi.fn().mockResolvedValue(Object.assign((async function* () {
        consumed.push('defer');
        yield deferState;
        consumed.push('later');
        yield laterState;
      })(), { cancel })),
    } as any);

    const result = unwrap(await runHybridReactAgent(makeCtx({ message: { text: { body: 'Sí, seguí' } } }) as any));
    const visible = JSON.stringify(result?.content ?? '');

    expect(consumed).toEqual(['defer']);
    expect(cancel).toHaveBeenCalledOnce();
    expect(visible).toContain(askMessage);
    expect(visible).not.toMatch(/Cantidad anotada|Anoté/);
    expect(visible).not.toContain('order_line_quantity_required');
  });

  it('Test I — set_order_line_quantity + add_cart_item exitosos: responde el agregado, no "Cantidad anotada"', async () => {
    const quantityResult = new ToolMessage({
      tool_call_id: 'tc-qty',
      name: 'set_order_line_quantity',
      content: JSON.stringify({
        success: true,
        effect: { kind: 'order_line_quantity_persisted', reference: 'line-ceviche' },
        orderLine: { id: 'line-ceviche', hint: 'ceviche', requestedQuantity: 2, status: 'active' },
        nextRequiredTool: 'add_cart_item',
        nextRequiredToolArgs: { orderLineId: 'line-ceviche', productId: 'prod-1', resolutionId: 'res-1', quantity: 2 },
      }),
    });
    const addResult = new ToolMessage({
      tool_call_id: 'tc-add',
      name: 'add_cart_item',
      content: JSON.stringify({
        success: true,
        effect: { kind: 'cart_item_persisted', reference: 'prod-1' },
        added: { productId: 'prod-1', itemName: 'Ceviche Clásico', quantity: 2 },
      }),
    });
    mockAgent({ invoke: vi.fn().mockResolvedValue({ messages: [quantityResult, addResult] }) });

    const result = unwrap(await runHybridReactAgent(makeCtx({ message: { text: { body: 'Dame 2' } } }) as any));
    const visible = JSON.stringify(result?.content ?? '');

    expect(visible).not.toMatch(/Cantidad anotada/);
    expect(buildCartSummaryMessage).toHaveBeenCalled();
  });

  it('cantidad persistida sin fulfillment posterior sigue respondiendo "Cantidad anotada"', async () => {
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [new ToolMessage({
          tool_call_id: 'tc-qty',
          name: 'set_order_line_quantity',
          content: JSON.stringify({
            success: true,
            effect: { kind: 'order_line_quantity_persisted', reference: 'line-ceviche' },
            orderLine: { id: 'line-ceviche', hint: 'ceviche', requestedQuantity: 2, status: 'active' },
          }),
        })],
      }),
    });

    const result = unwrap(await runHybridReactAgent(makeCtx({ message: { text: { body: 'Dame 2' } } }) as any));

    expect(JSON.stringify(result?.content ?? '')).toMatch(/Cantidad anotada/);
    expect(buildCartSummaryMessage).not.toHaveBeenCalled();
  });

  it('recuperación de task_resolution_mismatch agotada → respuesta segura, sin silencio ni confirmación falsa', async () => {
    const mismatch = (id: string) => new ToolMessage({
      tool_call_id: id,
      name: 'add_cart_item',
      content: JSON.stringify({ success: false, error: 'product_resolution_required', reason: 'task_resolution_mismatch' }),
    });
    // Estado completo como el grafo real: input del turno + AIMessage + resultado del paso de tools.
    mockAgent({
      invoke: vi.fn().mockImplementation(async (input: { messages: unknown[] }) => ({
        messages: [
          ...input.messages,
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'tc-add-1', name: 'add_cart_item', args: { orderLineId: 'line-papas' }, type: 'tool_call' }],
          }),
          mismatch('tc-add-1'),
        ],
      })),
    });

    const result = unwrap(await runHybridReactAgent(makeCtx({ message: { text: { body: 'Agregalo' } } }) as any));
    const visible = JSON.stringify(result?.content ?? '');

    expect(visible).toMatch(/No pude confirmar el agregado/);
    expect(visible).toMatch(/No pude completar la carga/);
    expect(visible).not.toMatch(/Agregué|Sumé|Listo/);
  });

  describe('rechazo sobre Task QUEUED → pregunta de cantidad de la Task ACTIVE (estado persistido)', () => {
    const R1 = 'pr1:biz-1:conv-1:res-ceviche';
    const resolution = (over: Record<string, unknown> = {}) => ({
      resolutionId: R1,
      productId: 'prod-1',
      businessId: 'biz-1',
      conversationId: 'conv-1',
      source: 'search_products',
      status: 'selected',
      scope: 'turn',
      turnId: 'turn-anterior',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...over,
    });
    const persisted = (active: { currentResolutionId: string | null; requestedQuantity: number | null }, resolutions: unknown[]) => ({
      peopleCount: 3,
      requestedPartySize: 3,
      humanIntentState: {
        version: 1, revision: 3, nextSequence: 2, processedMessageIds: [],
        records: [{ id: 'intent-1', sequence: 1, goal: 'PEDIR', request: { products: ['ceviche', 'papas'] }, status: 'ACTIVE', blockers: [], createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z' }],
      },
      pendingOrderLines: {
        lines: [
          { id: 'line-ceviche', hint: 'ceviche', status: 'active', ...active },
          { id: 'line-papas', hint: 'papas', requestedQuantity: null, status: 'queued', currentResolutionId: null },
        ],
        sourceMessage: 'Quiero un ceviche y unas papas',
        createdAt: '2026-10-07T00:00:00.000Z',
      },
      productResolutions: resolutions,
    });
    // El modelo se adelanta a papas (QUEUED): resolve_product rechaza con task_not_active.
    const queuedRejection = (input: { messages: unknown[] }) => ({
      messages: [
        ...input.messages,
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'tc-papas', name: 'resolve_product', args: { orderLineId: 'line-papas', productId: 'prod-papas', resolutionId: 'pr1:biz-1:conv-1:res-papas' }, type: 'tool_call' }],
        }),
        new ToolMessage({
          tool_call_id: 'tc-papas',
          name: 'resolve_product',
          content: JSON.stringify({ success: false, error: 'task_not_active', instruction: 'Esta línea del pedido todavía no está activa' }),
        }),
      ],
    });
    const run = async (metadata: unknown) => {
      vi.mocked(findOrCreateConversationState).mockResolvedValue({ metadata } as never);
      mockAgent({ invoke: vi.fn().mockImplementation(async (input: { messages: unknown[] }) => queuedRejection(input)) });
      const result = unwrap(await runHybridReactAgent(makeCtx({ message: { text: { body: 'El primero' } } }) as any));
      return JSON.stringify(result?.content ?? '');
    };

    it('TEST A — Task ACTIVE con resolución válida y sin cantidad: pregunta la cantidad de esa Task (nunca de la QUEUED)', async () => {
      const visible = await run(persisted({ currentResolutionId: R1, requestedQuantity: null }, [resolution()]));

      expect(visible).toContain('¿Cuántas unidades de Ceviche Clásico querés agregar?');
      expect(visible).not.toMatch(/papa/i);
      expect(visible).not.toMatch(/No pude confirmar/);
      expect(prisma.menu_item.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'prod-1', business_id: 'biz-1' } })
      );
    });

    it('TEST B — la Task ACTIVE ya tiene cantidad: no pregunta cantidad, fallback seguro', async () => {
      const visible = await run(persisted({ currentResolutionId: R1, requestedQuantity: 2 }, [resolution()]));

      expect(visible).toMatch(/No pude confirmar el agregado/);
      expect(visible).not.toMatch(/Cuántas unidades/);
    });

    it('TEST C — la Task ACTIVE no tiene ProductResolution: no construye pregunta, fallback seguro', async () => {
      const visible = await run(persisted({ currentResolutionId: null, requestedQuantity: null }, []));

      expect(visible).toMatch(/No pude confirmar el agregado/);
      expect(visible).not.toMatch(/Cuántas unidades/);
    });

    it.each([
      ['consumida', resolution({ status: 'consumed' })],
      ['vencida', resolution({ expiresAt: new Date(Date.now() - 1_000).toISOString() })],
      ['de otro business', resolution({ businessId: 'biz-otro' })],
    ])('TEST D — resolución de la Task ACTIVE %s: fail closed sin pregunta de cantidad', async (_label, entry) => {
      const visible = await run(persisted({ currentResolutionId: R1, requestedQuantity: null }, [entry]));

      expect(visible).toMatch(/No pude confirmar el agregado/);
      expect(visible).not.toMatch(/Cuántas unidades/);
    });
  });

  it('askMessage de un gate de tool llega al usuario y el JSON de control no', async () => {
    const askMessage = '¿Cuántas unidades de arroz con leche querés?';
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            tool_call_id: 'tc-qty-1',
            name: 'add_cart_item',
            content: JSON.stringify({
              success: false,
              error: 'quantity_required',
              askMessage,
            }),
          },
        ],
      }),
    } as any);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));
    const visible = JSON.stringify(result?.content ?? '');

    expect(visible).toContain(askMessage);
    expect(visible).not.toContain('quantity_required');
    expect(visible).not.toContain('success');
  });

  const listFor = (marker: string) => ({
    type: 'list' as const,
    header: { type: 'text' as const, text: marker },
    body: { text: marker },
    footer: { text: 'Elige un platillo' },
    action: { button: 'Ver platillos', sections: [] },
  });

  const presentationCount = (result: { followUps?: unknown[] } | null) =>
    1 + (result?.followUps?.length ?? 0);

  const assertNoPresentationSignal = (result: unknown) => {
    const visible = JSON.stringify(result ?? '');
    expect(visible).not.toContain('present_category');
    expect(visible).not.toContain('present_product_cta');
    expect(visible).not.toContain('"signal"');
  };

  it('present_category(A) luego present_category(B) conserva ambas, en el orden de tool_calls', async () => {
    const categoryA = 'e61a490b-72d1-4a88-be5a-97e31ea1ec1c';
    const categoryB = 'a7f6a71e-1574-41d9-bf3a-b3b411dc25af';
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            content: '',
            tool_calls: [
              { id: 'tc-a', name: 'present_category', args: { categoryId: categoryA } },
              { id: 'tc-b', name: 'present_category', args: { categoryId: categoryB } },
            ],
          },
          {
            tool_call_id: 'tc-b',
            name: 'present_category',
            content: JSON.stringify({
              signal: 'present_category',
              categoryId: categoryB,
              bodyText: 'Bebidas',
            }),
          },
          {
            tool_call_id: 'tc-a',
            name: 'present_category',
            content: JSON.stringify({
              signal: 'present_category',
              categoryId: categoryA,
              bodyText: 'Postres',
            }),
          },
        ],
      }),
    } as any);
    vi.mocked(buildCategoryProductListMessage).mockImplementation(
      async (_business, _conversation, categoryId) => ({
        message: listFor(String(categoryId)),
        conversationUpdated: true,
      })
    );

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(buildCategoryProductListMessage).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      categoryA,
      1,
      { bodyText: 'Postres' }
    );
    expect(buildCategoryProductListMessage).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      categoryB,
      1,
      { bodyText: 'Bebidas' }
    );
    expect(result!.isInteractive).toBe(true);
    expect(result!.content).toMatchObject({ header: { text: categoryA } });
    expect(result!.followUps).toEqual([
      { type: 'list', listMessage: listFor(categoryB) },
    ]);
    expect(presentationCount(result)).toBe(2);
    expect(buildCategoryProductListMessage).toHaveBeenCalledTimes(2);
    assertNoPresentationSignal(result);
  });

  it('ceviche + postre + bebidas: CTA y dos categorías, en el orden de tool_calls', async () => {
    const cevicheA = '742df439-a245-4414-8f30-289ab8097cac';
    const cevicheB = 'caae2144-8aef-40d8-a85b-aaa45e12a7f9';
    const postresId = 'e61a490b-72d1-4a88-be5a-97e31ea1ec1c';
    const bebidasId = 'a7f6a71e-1574-41d9-bf3a-b3b411dc25af';
    const intro = '🤖\n\n*Opciones* 🍽️\n\nElegí el ceviche.';

    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);
    vi.mocked(prisma.menu_item.findMany).mockResolvedValue([
      { id: cevicheA, name: 'Ceviche clásico', description: null, menu_item_price: [{ amount: 11 }] },
      { id: cevicheB, name: 'Ceviche mixto', description: null, menu_item_price: [{ amount: 13 }] },
    ] as any);
    vi.mocked(extractPrimaryProductId).mockReturnValue(null);
    vi.mocked(buildHybridCtaInteractive).mockReturnValue({
      content: listFor('ceviche-cta'),
      isInteractive: true,
    });
    vi.mocked(buildCategoryProductListMessage).mockImplementation(
      async (_business, _conversation, categoryId) => ({
        message: listFor(String(categoryId)),
        conversationUpdated: true,
      })
    );
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            content: intro,
            tool_calls: [
              {
                id: 'tc-cta',
                name: 'present_product_cta',
                args: { primaryKind: 'SELECT_FROM_LIST', productIds: [cevicheA, cevicheB] },
              },
              { id: 'tc-postres', name: 'present_category', args: { categoryId: postresId } },
              { id: 'tc-bebidas', name: 'present_category', args: { categoryId: bebidasId } },
            ],
          },
          {
            tool_call_id: 'tc-bebidas',
            name: 'present_category',
            content: JSON.stringify({
              signal: 'present_category',
              categoryId: bebidasId,
              bodyText: 'Y aquí están las bebidas frías.',
            }),
          },
          {
            tool_call_id: 'tc-cta',
            name: 'present_product_cta',
            content: JSON.stringify({
              signal: 'present_product_cta',
              primaryKind: 'SELECT_FROM_LIST',
              productIds: [cevicheA, cevicheB],
            }),
          },
          {
            tool_call_id: 'tc-postres',
            name: 'present_category',
            content: JSON.stringify({
              signal: 'present_category',
              categoryId: postresId,
              bodyText: 'Postres',
            }),
          },
        ],
      }),
    } as any);

    const result = unwrap(
      await runHybridReactAgent(
        makeCtx({ message: { text: { body: 'ceviche postre y bebidas' }, type: 'text' } }) as any
      )
    );

    expect(buildHybridCtaInteractive).toHaveBeenCalledOnce();
    const planArg = vi.mocked(buildHybridCtaInteractive).mock.calls[0][1];
    expect(planArg.primary.kind).toBe('SELECT_FROM_LIST');
    if (planArg.primary.kind === 'SELECT_FROM_LIST') {
      expect(planArg.primary.candidates.map((c) => c.productId)).toEqual([cevicheA, cevicheB]);
    }
    expect(buildCategoryProductListMessage).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.anything(),
      postresId,
      1,
      { bodyText: 'Postres' }
    );
    expect(buildCategoryProductListMessage).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.anything(),
      bebidasId,
      1,
      { bodyText: 'Y aquí están las bebidas frías.' }
    );
    expect(result!.content).toMatchObject({ header: { text: 'ceviche-cta' } });
    expect(result!.followUps).toEqual([
      { type: 'list', listMessage: listFor(postresId) },
      { type: 'list', listMessage: listFor(bebidasId) },
    ]);
    expect(presentationCount(result)).toBe(3);
    expect(buildHybridCtaInteractive).toHaveBeenCalledTimes(1);
    expect(buildCategoryProductListMessage).toHaveBeenCalledTimes(2);
    assertNoPresentationSignal(result);
  });

  it('una sola present_category sigue siendo un mensaje, sin followUps ni JSON de señal', async () => {
    const categoryId = '33333333-3333-3333-3333-333333333333';
    mockAgent({
      invoke: vi.fn().mockResolvedValue({
        messages: [
          {
            tool_call_id: 'tc-cat-1',
            name: 'present_category',
            content: JSON.stringify({ signal: 'present_category', categoryId }),
          },
        ],
      }),
    } as any);
    vi.mocked(buildCategoryProductListMessage).mockResolvedValue({
      message: listFor('solo-categoria'),
      conversationUpdated: true,
    });

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result!.isInteractive).toBe(true);
    expect(result!.content).toMatchObject({ header: { text: 'solo-categoria' } });
    expect(result!.followUps).toBeUndefined();
    expect(presentationCount(result)).toBe(1);
    expect(buildHybridCtaInteractive).not.toHaveBeenCalled();
    assertNoPresentationSignal(result);
  });

  it('una sola present_product_cta sigue siendo un mensaje, sin followUps ni JSON de señal', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);
    mockAgent({
      invoke: makeAgentInvokeWithPresentCta(BOT_TEXT, {
        primaryKind: 'ADD_ITEM',
        productId: 'prod-1',
        productHint: 'ceviche',
        quantity: 1,
      }),
    } as any);
    vi.mocked(buildHybridCtaInteractive).mockReturnValue({
      content: { type: 'interactive', interactive: { body: { text: 'Sumar ceviche' } } },
      isInteractive: true,
    });

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result!.isInteractive).toBe(true);
    expect(result!.followUps).toBeUndefined();
    expect(presentationCount(result)).toBe(1);
    expect(buildHybridCtaInteractive).toHaveBeenCalledOnce();
    expect(buildCategoryProductListMessage).not.toHaveBeenCalled();
    assertNoPresentationSignal(result);
  });
});
