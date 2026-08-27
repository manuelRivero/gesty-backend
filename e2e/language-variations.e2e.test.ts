/**
 * E2E Fase 3 — Language Variations.
 *
 * Misma intención + formulaciones distintas de WhatsApp → mismo efecto
 * funcional (carrito, pending, checkout_active, fulfillment). No copy del LLM.
 *
 * No re-prueba la máquina de estados de Fase 2: el setup dispara el gate
 * (botón / lastOffer) y la variante tipable es lo que se valida.
 *
 * Ver RESULTADOS-E2E-LANGUAGE-VARIATIONS.md y e2e/README.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyE2eEnv,
  E2E_CUSTOMER_PHONE,
  e2eSkipReason,
  isE2eEnabled,
} from './helpers/env';
import {
  addItemViaButtonHappyPath,
  buildInteractivePayload,
  buildTextPayload,
  disconnectPrisma,
  findE2eAddableProduct,
  findE2eProductWithVariations,
  findE2eQuantityGateProduct,
  getActiveDraftItemCount,
  getActiveDraftItems,
  getFreshConversationMetadata,
  hasHandlerResponse,
  hasInteractiveFollowUp,
  hasListFollowUp,
  loadMainGraph,
  resetE2eCustomer,
  runGraphTurn,
  type MainGraph,
} from './helpers/graphHarness';
import { getPendingAddQuantity } from '../src/services/pendingAddQuantity.service';
import { getPendingVariation } from '../src/services/pendingVariation.service';
import { getLastOffer, persistLastOffer } from '../src/services/lastOffer.service';

const normalizeLabel = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\.$/, '')
    .toLowerCase()
    .trim();

describe.sequential.skipIf(!isE2eEnabled())('language variations (e2e fase 3)', () => {
  let graph: MainGraph;
  let businessId: string;
  let conversationId: string;

  beforeAll(async () => {
    applyE2eEnv({ CHECKOUT_AGENT_ENABLED: 'true', HYBRID_CTA_ENABLED: 'true' });
    graph = await loadMainGraph();
    const reset = await resetE2eCustomer();
    businessId = reset.businessId;
    conversationId = reset.conversationId;
  }, 60_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

  /** Cierra tipables de add (variación/cantidad) si el LLM los abrió. */
  const resolvePendingAddGates = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) {
      const count = await getActiveDraftItemCount(businessId);
      if (count > 0) return;

      const meta = await getFreshConversationMetadata(conversationId);
      const pendingVar = getPendingVariation(meta);
      if (pendingVar?.variations?.length) {
        await runGraphTurn(graph, buildTextPayload(pendingVar.variations[0]));
        continue;
      }
      const pendingQty = getPendingAddQuantity(meta);
      if (pendingQty) {
        await runGraphTurn(
          graph,
          buildTextPayload(String(pendingQty.suggestedQuantity))
        );
        continue;
      }
      break;
    }
  };

  const looksLikeMenuSignal = (
    state: Awaited<ReturnType<typeof runGraphTurn>>
  ): boolean => {
    if (hasListFollowUp(state.handlerResult) || hasInteractiveFollowUp(state.handlerResult)) {
      return true;
    }
    if (state.handlerResult?.isInteractive) return true;
    if (state.conversation?.lastReferencedProductId) return true;
    const intent = state.detection?.intent;
    if (
      intent === 'VIEW_MENU' ||
      intent === 'PRODUCT_QUERY' ||
      intent === 'MENU_BY_TAG' ||
      intent === 'ORDER_FOOD'
    ) {
      return hasHandlerResponse(state.handlerResult);
    }
    return hasHandlerResponse(state.handlerResult);
  };

  // ── A. Consulta de menú ───────────────────────────────────────────────

  describe.sequential('A. menú', () => {
    it.each([
      { category: 'directo', message: 'Qué tienen?' },
      { category: 'coloquial', message: 'Mostrame el menú' },
    ] as const)(
      '$category: "$message" → señal de menú / respuesta',
      async ({ message }) => {
        const reset = await resetE2eCustomer();
        conversationId = reset.conversationId;

        const turn = await runGraphTurn(graph, buildTextPayload(message));
        expect(hasHandlerResponse(turn.handlerResult)).toBe(true);
        expect(looksLikeMenuSignal(turn)).toBe(true);
        expect(await getActiveDraftItemCount(businessId)).toBe(0);
      },
      120_000
    );
  });

  // ── B. Pedido ambiguo (multi-SKU ceviche → shortlist, no auto-add) ────
  //
  // Con varios "ceviche" en menú el híbrido hace search + SELECT_FROM_LIST
  // (prompt ANTI-MULTI-PRODUCTO). El efecto funcional de la intención es
  // shortlist, no carrito. Add real se valida en B2 vía lastOffer.

  describe.sequential('B. pedido ambiguo → shortlist', () => {
    const hasShortlistSignal = (meta: Record<string, unknown> | undefined): boolean =>
      meta?.pendingProductSelection === true ||
      (Array.isArray(meta?.candidateProductIds) && meta.candidateProductIds.length >= 2) ||
      getLastOffer(meta) != null;

    it.each([
      { category: 'directo', message: 'Quiero un ceviche' },
      { category: 'conversacional', message: 'Me das un ceviche?' },
      { category: 'coloquial', message: 'Agregame un ceviche' },
    ] as const)(
      '$category: "$message" → shortlist / oferta (sin auto-add)',
      async ({ message }) => {
        const reset = await resetE2eCustomer();
        conversationId = reset.conversationId;

        const turn = await runGraphTurn(graph, buildTextPayload(message));
        expect(hasHandlerResponse(turn.handlerResult)).toBe(true);

        const meta = await getFreshConversationMetadata(conversationId);
        const structuralList =
          hasListFollowUp(turn.handlerResult) ||
          hasInteractiveFollowUp(turn.handlerResult) ||
          turn.handlerResult?.isInteractive === true;
        expect(hasShortlistSignal(meta) || structuralList).toBe(true);
        expect(await getActiveDraftItemCount(businessId)).toBe(0);
      },
      180_000
    );
  });

  // ── B2. Confirmar oferta (mismo add; lenguaje distinto) ────────────────

  describe.sequential('B2. confirmar oferta → carrito', () => {
    it.each([
      { category: 'coloquial', message: 'Dale, agregame uno' },
      { category: 'conversacional', message: 'Me agregás uno?' },
      { category: 'corto', message: 'Poneme uno' },
    ] as const)(
      '$category: "$message" → ítem en carrito',
      async ({ message }) => {
        const reset = await resetE2eCustomer();
        conversationId = reset.conversationId;
        const product = await findE2eAddableProduct(businessId);

        await persistLastOffer({
          conversationId,
          productId: product.id,
          productName: product.name,
          suggestedQuantity: 1,
          source: 'hybrid_cta',
        });

        expect(await getActiveDraftItemCount(businessId)).toBe(0);

        const turn = await runGraphTurn(graph, buildTextPayload(message));
        expect(hasHandlerResponse(turn.handlerResult)).toBe(true);
        await resolvePendingAddGates();

        const items = await getActiveDraftItems(businessId);
        expect(items.length).toBeGreaterThan(0);
        const line = items.find((i) => i.product_id === product.id) ?? items[0];
        expect(line.quantity).toBeGreaterThanOrEqual(1);

        const meta = await getFreshConversationMetadata(conversationId);
        expect(getPendingVariation(meta)).toBeNull();
        expect(getPendingAddQuantity(meta)).toBeNull();
      },
      240_000
    );
  });

  // ── C. Cantidad (resolver pending; setup = botón Fase 2) ───────────────

  describe.sequential('C. cantidad', () => {
    it.each([
      {
        category: 'corto',
        buildMessage: (suggested: number) => String(suggested),
      },
      {
        category: 'conversacional',
        buildMessage: (suggested: number) => `Dame ${suggested}`,
      },
      {
        category: 'confirmación',
        buildMessage: (_suggested: number) => 'Dale',
      },
    ] as const)(
      '$category → pendingAddQuantity resuelto con qty sugerida',
      async ({ buildMessage }) => {
        const reset = await resetE2eCustomer();
        conversationId = reset.conversationId;

        const product = await findE2eQuantityGateProduct(businessId);
        await runGraphTurn(
          graph,
          buildInteractivePayload(`ADD_ITEM:${product.id}:1`)
        );

        const metaGate = await getFreshConversationMetadata(conversationId);
        const pending = getPendingAddQuantity(metaGate);
        expect(pending?.productId).toBe(product.id);
        expect(pending!.suggestedQuantity).toBeGreaterThanOrEqual(2);
        expect(await getActiveDraftItemCount(businessId)).toBe(0);

        const qty = pending!.suggestedQuantity;
        const resolveTurn = await runGraphTurn(
          graph,
          buildTextPayload(buildMessage(qty))
        );
        expect(hasHandlerResponse(resolveTurn.handlerResult)).toBe(true);

        const items = await getActiveDraftItems(businessId);
        const line = items.find((i) => i.product_id === product.id);
        expect(line?.quantity).toBe(qty);

        const metaDone = await getFreshConversationMetadata(conversationId);
        expect(getPendingAddQuantity(metaDone)).toBeNull();
      },
      180_000
    );
  });

  // ── D. Variación (resolver pending; setup = lastOffer híbrido) ────────

  describe.sequential('D. variación', () => {
    it.each([
      {
        category: 'directo',
        buildMessage: (variation: string) => variation,
      },
      {
        category: 'conversacional',
        buildMessage: (variation: string) => `Quiero el ${variation}`,
      },
    ] as const)(
      '$category → carrito con variación persistida',
      async ({ buildMessage }) => {
        const reset = await resetE2eCustomer();
        conversationId = reset.conversationId;

        const product = await findE2eProductWithVariations(businessId);
        const expectedVariation = product.variations[0];
        expect(expectedVariation).toBeTruthy();

        await persistLastOffer({
          conversationId,
          productId: product.id,
          productName: product.name,
          suggestedQuantity: 1,
          source: 'hybrid_cta',
        });

        await runGraphTurn(graph, buildTextPayload('Agrega uno'));
        let meta = await getFreshConversationMetadata(conversationId);
        let pendingVar = getPendingVariation(meta);
        expect(pendingVar?.productId).toBe(product.id);
        expect(await getActiveDraftItemCount(businessId)).toBe(0);

        await runGraphTurn(
          graph,
          buildTextPayload(buildMessage(pendingVar!.variations[0]))
        );

        for (let step = 0; step < 3; step++) {
          const count = await getActiveDraftItemCount(businessId);
          if (count > 0) break;
          meta = await getFreshConversationMetadata(conversationId);
          const pendingQty = getPendingAddQuantity(meta);
          if (pendingQty?.productId === product.id) {
            await runGraphTurn(
              graph,
              buildTextPayload(String(pendingQty.suggestedQuantity))
            );
            continue;
          }
          pendingVar = getPendingVariation(meta);
          if (pendingVar?.productId === product.id) {
            await runGraphTurn(
              graph,
              buildTextPayload(pendingVar.variations[0])
            );
            continue;
          }
          break;
        }

        meta = await getFreshConversationMetadata(conversationId);
        const items = await getActiveDraftItems(businessId);
        const line = items.find((i) => i.product_id === product.id);
        expect(line).toBeTruthy();
        const expected = normalizeLabel(expectedVariation);
        const got = normalizeLabel(line!.variation ?? '');
        expect(got).toContain(expected.slice(0, Math.min(10, expected.length)));
        expect(getPendingVariation(meta)).toBeNull();
        expect(getPendingAddQuantity(meta)).toBeNull();
      },
      240_000
    );
  });

  // ── E. Checkout (prosa; carrito vía botón) ─────────────────────────────

  describe.sequential('E. checkout', () => {
    it.each([
      { category: 'directo', message: 'quiero finalizar el pedido' },
      { category: 'conversacional', message: 'listo para pagar' },
    ] as const)(
      '$category: "$message" → checkout_active',
      async ({ message }) => {
        const reset = await resetE2eCustomer();
        conversationId = reset.conversationId;
        const product = await findE2eAddableProduct(businessId);
        await addItemViaButtonHappyPath({
          graph,
          businessId,
          productId: product.id,
        });

        const { patchConversationMetadata } = await import(
          '../src/repositories/conversationState.repository'
        );
        await patchConversationMetadata(conversationId, { checkout_active: false });

        const turn = await runGraphTurn(graph, buildTextPayload(message));
        expect(hasHandlerResponse(turn.handlerResult)).toBe(true);

        const meta = await getFreshConversationMetadata(conversationId);
        expect(meta?.checkout_active).toBe(true);
      },
      180_000
    );
  });

  // ── F. Fulfillment ────────────────────────────────────────────────────

  describe.sequential('F. fulfillment', () => {
    const startCheckoutSession = async (): Promise<void> => {
      const product = await findE2eAddableProduct(businessId);
      await addItemViaButtonHappyPath({
        graph,
        businessId,
        productId: product.id,
      });
      await runGraphTurn(graph, buildInteractivePayload('CHECKOUT'));
      const meta = await getFreshConversationMetadata(conversationId);
      expect(meta?.checkout_active).toBe(true);
    };

    it.each([
      { category: 'corto', message: 'en casa', expected: 'DELIVERY' as const },
      {
        category: 'directo',
        message: 'quiero delivery',
        expected: 'DELIVERY' as const,
      },
      { category: 'corto', message: 'retiro', expected: 'TAKE_AWAY' as const },
      {
        category: 'conversacional',
        message: 'paso a buscar',
        expected: 'TAKE_AWAY' as const,
      },
    ] as const)(
      '$category: "$message" → $expected',
      async ({ message, expected }) => {
        const reset = await resetE2eCustomer();
        conversationId = reset.conversationId;
        await startCheckoutSession();

        const turn = await runGraphTurn(graph, buildTextPayload(message));
        expect(hasHandlerResponse(turn.handlerResult)).toBe(true);

        const { prisma } = await import('../src/lib/prisma');
        const draft = await prisma.draft_order.findFirst({
          where: {
            business_id: businessId,
            customer_phone: E2E_CUSTOMER_PHONE,
            status: 'active',
          },
          select: { fulfillment_type: true },
        });
        expect(draft?.fulfillment_type).toBe(expected);
      },
      180_000
    );
  });
});

describe('language variations (e2e fase 3) — skip info', () => {
  it('documenta requisitos si e2e está deshabilitado', () => {
    if (isE2eEnabled()) return;
    expect(e2eSkipReason()).toBeTruthy();
  });
});
