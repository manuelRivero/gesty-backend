/**
 * Tests de integración para runHybridReactAgent.
 *
 * Mockea: createReactAgent, ctaPlanner, ctaResolver, whatsappBuilders/hybridCta,
 *         repositories (patchConversationMetadata), MenuService.
 *
 * Escenarios:
 *  1. Flag off → texto plano (comportamiento actual).
 *  2. Producto resoluble → HandlerResult interactivo con ADD_ITEM.
 *  3. Respuesta sin producto → CTA VIEW_MENU.
 *  4. Cooldown activo → texto plano.
 *  5. Planner devuelve null → texto plano.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks de módulos externos ----

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
    isHybridAgentMode: vi.fn(() => true),
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

// ---- Imports bajo test ----

import { runHybridReactAgent, resetAgentCacheForTesting } from '../reactAgent';
import type { HybridAgentRunResult } from '../reactAgent';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { isHybridCtaEnabled, isHybridCtaEnabledForBusiness } from '../../config/env';
import { planCta } from '../ctaPlanner';
import { resolveCta } from '../ctaResolver';
import { buildHybridCtaInteractive } from '../../whatsappBuilders/hybridCta';
import { patchConversationMetadata } from '../../repositories';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runHybridReactAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Resetear el singleton del agente ReAct para que el mock de createReactAgent
    // sea tomado en cada test.
    resetAgentCacheForTesting();
    // ReAct agent mock por defecto devuelve texto del bot
    vi.mocked(createReactAgent).mockReturnValue({
      invoke: makeAgentInvoke(BOT_TEXT),
    } as any);
  });

  it('Escenario 1: flag off → retorna texto plano sin CTA', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(false);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(false);

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result).not.toBeNull();
    expect(result!.isInteractive).toBe(false);
    expect(typeof result!.content).toBe('string');
    expect(planCta).not.toHaveBeenCalled();
  });

  it('Escenario 2: flag on + producto resoluble → HandlerResult interactivo ADD_ITEM', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);
    vi.mocked(planCta).mockResolvedValue({
      shouldShowCta: true,
      productHint: 'ceviche',
      primaryKind: 'ADD_ITEM',
      primaryLabel: 'Agregar 🛒',
      secondaryKind: 'VIEW_FEATURED',
      secondaryLabel: 'Ver destacados',
    });
    vi.mocked(resolveCta).mockResolvedValue({
      primary: { kind: 'ADD_ITEM', productId: 'prod-1', quantity: 1, label: 'Agregar 🛒' },
      secondary: { kind: 'VIEW_FEATURED', label: 'Ver destacados' },
    });
    vi.mocked(buildHybridCtaInteractive).mockReturnValue({
      content: { type: 'interactive', interactive: {} },
      isInteractive: true,
    });

    const result = unwrap(await runHybridReactAgent(makeCtx() as any));

    expect(result!.isInteractive).toBe(true);
    expect(planCta).toHaveBeenCalledOnce();
    expect(resolveCta).toHaveBeenCalledOnce();
    expect(buildHybridCtaInteractive).toHaveBeenCalledOnce();
    expect(patchConversationMetadata).toHaveBeenCalledOnce();
  });

  it('Escenario 3: planner retorna VIEW_MENU → CTA VIEW_MENU', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);
    vi.mocked(planCta).mockResolvedValue({
      shouldShowCta: true,
      productHint: null,
      primaryKind: 'VIEW_MENU',
      primaryLabel: 'Ver menú',
      secondaryKind: 'VIEW_FEATURED',
      secondaryLabel: 'Ver destacados',
    });
    vi.mocked(resolveCta).mockResolvedValue({
      primary: { kind: 'VIEW_MENU', label: 'Ver menú' },
      secondary: { kind: 'VIEW_FEATURED', label: 'Ver destacados' },
    });
    vi.mocked(buildHybridCtaInteractive).mockReturnValue({
      content: { type: 'interactive', interactive: {} },
      isInteractive: true,
    });

    const result = unwrap(
      await runHybridReactAgent(
        makeCtx({
          detection: {
            intent: 'PRODUCT_QUERY',
            confidence: 0.9,
            detectedProductName: null,
            quantity: null,
            candidates: [],
            raw: null,
          },
        }) as any
      )
    );

    expect(result!.isInteractive).toBe(true);
    expect(resolveCta).toHaveBeenCalledOnce();
  });

  it('Escenario 4: cooldown activo → texto plano', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);

    const recentCta = new Date(Date.now() - 60_000).toISOString(); // hace 1 minuto
    const ctxWithCooldown = makeCtx({
      conversationState: {
        metadata: {
          lastCtaShownAt: recentCta,
          lastCtaProductId: 'old-prod',
          lastCtaPayload: 'ADD_ITEM:old-prod:1',
        },
      },
    });

    const result = unwrap(await runHybridReactAgent(ctxWithCooldown as any));

    expect(result!.isInteractive).toBe(false);
    expect(planCta).not.toHaveBeenCalled();
  });

  it('Escenario 5: planner retorna null → texto plano', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);
    vi.mocked(planCta).mockResolvedValue(null);

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

  it('baja confianza → texto plano (skip CTA)', async () => {
    vi.mocked(isHybridCtaEnabled).mockReturnValue(true);
    vi.mocked(isHybridCtaEnabledForBusiness).mockReturnValue(true);

    const result = unwrap(
      await runHybridReactAgent(
        makeCtx({
          detection: {
            intent: 'PRODUCT_ATTRIBUTE_QUESTION',
            confidence: 0.4, // < MIN_CTA_CONFIDENCE
            detectedProductName: 'ceviche',
            quantity: null,
            candidates: [],
            raw: null,
          },
        }) as any
      )
    );

    expect(result!.isInteractive).toBe(false);
    expect(planCta).not.toHaveBeenCalled();
  });

  it('shortlist de tools ≥2 → followUp lista y sin pipeline CTA (evita IDs desalineados)', async () => {
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
    expect(result!.followUps).toHaveLength(1);
    expect(result!.followUps![0].type).toBe('list');
    expect(planCta).not.toHaveBeenCalled();
    expect(resolveCta).not.toHaveBeenCalled();
    expect(buildHybridCtaInteractive).not.toHaveBeenCalled();
    expect(patchConversationMetadata).toHaveBeenCalledWith(
      'conv-1',
      expect.objectContaining({
        pendingProductSelection: true,
        candidateProductIds: ['prod-a', 'prod-b'],
      })
    );
  });
});
