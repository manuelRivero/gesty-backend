/**
 * Tests de integración para runHybridReactAgent.
 *
 * CTA: el agente pide `present_product_cta` (signal). Ya no corre ctaPlanner post-proceso.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@langchain/langgraph/prebuilt', () => ({
  createReactAgent: vi.fn(),
}));

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

vi.mock('../../whatsappBuilders/hybridCta', () => ({
  buildHybridCtaInteractive: vi.fn(),
  extractPrimaryPayload: vi.fn(() => 'ADD_ITEM:prod-1:1'),
  extractPrimaryProductId: vi.fn(() => 'prod-1'),
}));

vi.mock('../../repositories', () => ({
  patchConversationMetadata: vi.fn().mockResolvedValue(undefined),
  findOrCreateConversationState: vi.fn(),
}));

vi.mock('../../services/menu.service', () => ({
  MenuService: { searchMenuItemsByKeyword: vi.fn().mockResolvedValue([]) },
}));

vi.mock('../../config/llm', () => ({
  getReactReasonerLlm: vi.fn(() => ({})),
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
  },
}));

vi.mock('../../services/category.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/category.service')>();
  return {
    ...actual,
    buildCategoryProductListMessage: vi.fn(),
  };
});

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
import { patchConversationMetadata } from '../../repositories';
import { prisma } from '../../lib/prisma';
import { buildCategoryProductListMessage } from '../../services/category.service';

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
    vi.mocked(createReactAgent).mockReturnValue({
      invoke: makeAgentInvoke(BOT_TEXT),
    } as any);
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

  it('present_product_cta ADD_ITEM con productId → interactive sin planCta', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);
    vi.mocked(createReactAgent).mockReturnValue({
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
    vi.mocked(createReactAgent).mockReturnValue({
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
    vi.mocked(createReactAgent).mockReturnValue({
      invoke: makeAgentInvokeWithPresentCta(introText, {
        primaryKind: 'SELECT_FROM_LIST',
        productIds: [idA, idB],
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
    vi.mocked(createReactAgent).mockReturnValue({
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

  it('flag CTA off + present_product_cta → texto plano', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(false);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(false);
    vi.mocked(createReactAgent).mockReturnValue({
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
    vi.mocked(createReactAgent).mockReturnValue({
      invoke: vi.fn().mockResolvedValue({ messages: [] }),
    } as any);

    const result = await runHybridReactAgent(makeCtx() as any);
    expect(result).toBeNull();
  });

  it('present_category → lista de categoría sin present_product_cta', async () => {
    const categoryId = '33333333-3333-3333-3333-333333333333';
    vi.mocked(createReactAgent).mockReturnValue({
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
      1
    );
    expect(buildHybridCtaInteractive).not.toHaveBeenCalled();
  });

  it('shortlist de tools ≥2 sin present_product_cta → texto plano (sin lista automática)', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);

    const introText =
      '🤖\n\n*Opciones* 🍽️\n\n¡Qué buena idea! Hay varias pizzanesas que te pueden gustar.';
    vi.mocked(createReactAgent).mockReturnValue({
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
    vi.mocked(createReactAgent).mockReturnValue({
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
    vi.mocked(createReactAgent).mockReturnValue({
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
});
