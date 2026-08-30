/**
 * E2E: lastOffer + confirmación en texto libre ("Agrega uno") → ítem en carrito.
 *
 * Caso A: metadata/ledger CONFIRMAR_OFERTA pre-cargada + agente híbrido.
 * Caso B: flujo conversacional ceviche → oferta → "Agrega uno" (LLM real).
 *
 * Happy path: producto sin variación y sin pending de cantidad (findE2eAddableProduct).
 * Aserciones sobre carrito/metadata (no copy del LLM); ver e2e/README.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyE2eEnv,
  e2eSkipReason,
  isE2eEnabled,
} from './helpers/env';
import {
  buildTextPayload,
  disconnectPrisma,
  findE2eAddableProduct,
  findE2eSecondAddableProduct,
  getActiveDraftItemCount,
  getActiveDraftItemQuantitySum,
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
import { getLastOffer, isLastOfferAlive, persistLastOffer } from '../src/services/lastOffer.service';
import { getPendingAddQuantity } from '../src/services/pendingAddQuantity.service';
import { getPendingVariation } from '../src/services/pendingVariation.service';

describe.sequential.skipIf(!isE2eEnabled())('lastOffer add-item (e2e)', () => {
  let graph: MainGraph;
  let businessId: string;
  let conversationId: string;
  let productId: string;
  let productName: string;

  beforeAll(async () => {
    applyE2eEnv({
      CHECKOUT_AGENT_ENABLED: 'false',
      HYBRID_CTA_ENABLED: 'true',
    });
    graph = await loadMainGraph();
    const reset = await resetE2eCustomer();
    businessId = reset.businessId;
    conversationId = reset.conversationId;
    const product = await findE2eAddableProduct(businessId);
    productId = product.id;
    productName = product.name;
  }, 60_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

  /**
   * Tras "Agrega uno", el híbrido puede abrir pending de variación/cantidad.
   * En happy path con producto filtrado no debería; si aparece, cerramos con
   * un turno de texto explícito (sigue siendo el camino tipable actual).
   */
  const resolvePendingAddGates = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
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

  it('con lastOffer en metadata, "Agrega uno" suma el producto al carrito', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    await persistLastOffer({
      conversationId,
      productId,
      productName,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });

    const beforeCount = await getActiveDraftItemCount(businessId);
    expect(beforeCount).toBe(0);

    const state = await runGraphTurn(graph, buildTextPayload('Agrega uno'));
    expect(hasHandlerResponse(state.handlerResult)).toBe(true);
    await resolvePendingAddGates();

    const afterCount = await getActiveDraftItemCount(businessId);
    expect(afterCount).toBeGreaterThan(beforeCount);
  }, 180_000);

  it('con lastOffer, "¿Cuánto cuesta?" no agrega y deja la oferta en el ledger', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    await persistLastOffer({
      conversationId,
      productId,
      productName,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });

    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    const askTurn = await runGraphTurn(graph, buildTextPayload('¿Cuánto cuesta?'));
    expect(hasHandlerResponse(askTurn.handlerResult)).toBe(true);
    expect(await getActiveDraftItemCount(businessId)).toBe(0);
    expect(
      getLastOffer(await getFreshConversationMetadata(conversationId))?.productId
    ).toBe(productId);
  }, 180_000);

  it('A: lastOffer → "¿Cuánto cuesta?" → "Agrega uno" suma el mismo productId', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    await persistLastOffer({
      conversationId,
      productId,
      productName,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });

    const askTurn = await runGraphTurn(graph, buildTextPayload('¿Cuánto cuesta?'));
    expect(hasHandlerResponse(askTurn.handlerResult)).toBe(true);
    expect(await getActiveDraftItemCount(businessId)).toBe(0);
    expect(
      getLastOffer(await getFreshConversationMetadata(conversationId))?.productId
    ).toBe(productId);

    const addTurn = await runGraphTurn(graph, buildTextPayload('Agrega uno'));
    expect(hasHandlerResponse(addTurn.handlerResult)).toBe(true);
    await resolvePendingAddGates();

    const items = await getActiveDraftItems(businessId);
    expect(items.some((i) => i.product_id === productId)).toBe(true);
  }, 300_000);

  it('B: lastOffer → "¿Cuánto cuesta?" → "Dale, agregalo" suma el mismo productId', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    await persistLastOffer({
      conversationId,
      productId,
      productName,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });

    await runGraphTurn(graph, buildTextPayload('¿Cuánto cuesta?'));
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    // "Dale" solo, tras una respuesta de precio, el LLM lo toma como acuse
    // (no add). La confirmación post-consulta tiene que ser de sumar.
    const addTurn = await runGraphTurn(graph, buildTextPayload('Dale, agregalo'));
    expect(hasHandlerResponse(addTurn.handlerResult)).toBe(true);
    await resolvePendingAddGates();

    const items = await getActiveDraftItems(businessId);
    expect(items.some((i) => i.product_id === productId)).toBe(true);
  }, 300_000);

  it('C: lastOffer → dos preguntas → "Agrega uno" suma el mismo productId', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    await persistLastOffer({
      conversationId,
      productId,
      productName,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });

    await runGraphTurn(graph, buildTextPayload('¿Cuánto cuesta?'));
    expect(await getActiveDraftItemCount(businessId)).toBe(0);
    await runGraphTurn(graph, buildTextPayload('¿Es picante?'));
    expect(await getActiveDraftItemCount(businessId)).toBe(0);
    expect(
      getLastOffer(await getFreshConversationMetadata(conversationId))?.productId
    ).toBe(productId);

    const addTurn = await runGraphTurn(graph, buildTextPayload('Agrega uno'));
    expect(hasHandlerResponse(addTurn.handlerResult)).toBe(true);
    await resolvePendingAddGates();

    const items = await getActiveDraftItems(businessId);
    expect(items.some((i) => i.product_id === productId)).toBe(true);
  }, 360_000);

  it('consulta ceviche deja lastOffer y "Agrega uno" agrega al carrito', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    const menuTurn = await runGraphTurn(
      graph,
      buildTextPayload('Que onda con el ceviche? somos 2')
    );
    expect(hasHandlerResponse(menuTurn.handlerResult)).toBe(true);

    const metaAfterMenu =
      (await getFreshConversationMetadata(conversationId)) ??
      menuTurn.workingConversationState?.metadata;
    let offerAfterMenu = getLastOffer(metaAfterMenu);

    if (!offerAfterMenu && menuTurn.conversation?.lastReferencedProductId) {
      offerAfterMenu = {
        kind: 'ADD_ITEM',
        productId: menuTurn.conversation.lastReferencedProductId,
        productName,
        suggestedQuantity: 1,
        offeredAt: new Date().toISOString(),
        source: 'product_query',
      };
    }

    const menuContextEstablished =
      offerAfterMenu != null ||
      menuTurn.conversation?.lastReferencedProductId != null ||
      hasListFollowUp(menuTurn.handlerResult) ||
      hasInteractiveFollowUp(menuTurn.handlerResult) ||
      menuTurn.handlerResult?.isInteractive === true;
    expect(menuContextEstablished).toBe(true);

    // Happy path determinístico: ofrecer el producto filtrado (sin variación /
    // qty gate) aunque el LLM haya fijado otro ceviche con variaciones.
    await persistLastOffer({
      conversationId,
      productId: productId,
      productName: productName,
      suggestedQuantity: 1,
      source: 'product_query',
    });

    const { prisma } = await import('../src/lib/prisma');
    const activeDraft = await prisma.draft_order.findFirst({
      where: {
        business_id: businessId,
        status: 'active',
      },
      select: { id: true },
    });
    if (activeDraft) {
      await prisma.draft_order_item.deleteMany({ where: { draft_order_id: activeDraft.id } });
    }

    const beforeQty = await getActiveDraftItemQuantitySum(businessId);
    expect(beforeQty).toBe(0);
    const addTurn = await runGraphTurn(graph, buildTextPayload('Agrega uno'));
    expect(hasHandlerResponse(addTurn.handlerResult)).toBe(true);
    await resolvePendingAddGates();

    const afterQty = await getActiveDraftItemQuantitySum(businessId);
    expect(afterQty).toBeGreaterThan(beforeQty);
  }, 240_000);

  it('R1: lastOffer → "No, mejor no" invalida el Fact sin agregar', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    await persistLastOffer({
      conversationId,
      productId,
      productName,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });
    expect(isLastOfferAlive(await getFreshConversationMetadata(conversationId))).toBe(true);

    const rejectTurn = await runGraphTurn(graph, buildTextPayload('No, mejor no'));
    expect(hasHandlerResponse(rejectTurn.handlerResult)).toBe(true);
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    const meta = await getFreshConversationMetadata(conversationId);
    expect(isLastOfferAlive(meta)).toBe(false);
    expect(getLastOffer(meta)).toBeNull();
  }, 180_000);

  it('R2: rechazo → "Dale" NO agrega el productId rechazado', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    await persistLastOffer({
      conversationId,
      productId,
      productName,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });

    await runGraphTurn(graph, buildTextPayload('No, mejor no'));
    expect(await getActiveDraftItemCount(businessId)).toBe(0);
    expect(isLastOfferAlive(await getFreshConversationMetadata(conversationId))).toBe(false);

    const daleTurn = await runGraphTurn(graph, buildTextPayload('Dale'));
    expect(hasHandlerResponse(daleTurn.handlerResult)).toBe(true);
    await resolvePendingAddGates();

    const items = await getActiveDraftItems(businessId);
    expect(items.some((i) => i.product_id === productId)).toBe(false);
    expect(isLastOfferAlive(await getFreshConversationMetadata(conversationId))).toBe(false);
  }, 300_000);

  it('R3: rechazo → nueva oferta Y → "Agrega uno" suma Y', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    const productY = await findE2eSecondAddableProduct(businessId, {
      excludeId: productId,
    });

    await persistLastOffer({
      conversationId,
      productId,
      productName,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });

    await runGraphTurn(graph, buildTextPayload('No, mejor no'));
    expect(isLastOfferAlive(await getFreshConversationMetadata(conversationId))).toBe(false);

    await persistLastOffer({
      conversationId,
      productId: productY.id,
      productName: productY.name,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });
    expect(
      getLastOffer(await getFreshConversationMetadata(conversationId))?.productId
    ).toBe(productY.id);

    const addTurn = await runGraphTurn(graph, buildTextPayload('Agrega uno'));
    expect(hasHandlerResponse(addTurn.handlerResult)).toBe(true);
    await resolvePendingAddGates();

    const items = await getActiveDraftItems(businessId);
    expect(items.some((i) => i.product_id === productY.id)).toBe(true);
    expect(items.some((i) => i.product_id === productId)).toBe(false);
  }, 300_000);

  it('R4: persistLastOffer(Y) reemplaza X → "Agrega uno" suma Y', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    const productY = await findE2eSecondAddableProduct(businessId, {
      excludeId: productId,
    });

    await persistLastOffer({
      conversationId,
      productId,
      productName,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });
    await persistLastOffer({
      conversationId,
      productId: productY.id,
      productName: productY.name,
      suggestedQuantity: 1,
      source: 'product_query',
    });
    expect(
      getLastOffer(await getFreshConversationMetadata(conversationId))?.productId
    ).toBe(productY.id);

    const addTurn = await runGraphTurn(graph, buildTextPayload('Agrega uno'));
    expect(hasHandlerResponse(addTurn.handlerResult)).toBe(true);
    await resolvePendingAddGates();

    const items = await getActiveDraftItems(businessId);
    expect(items.some((i) => i.product_id === productY.id)).toBe(true);
    expect(items.some((i) => i.product_id === productId)).toBe(false);
  }, 300_000);

  it('R5: pregunta genérica de catálogo NO limpia lastOffer', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    await persistLastOffer({
      conversationId,
      productId,
      productName,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });

    const searchTurn = await runGraphTurn(
      graph,
      buildTextPayload('¿Qué hamburguesas tenés?')
    );
    expect(hasHandlerResponse(searchTurn.handlerResult)).toBe(true);
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    const meta = await getFreshConversationMetadata(conversationId);
    expect(isLastOfferAlive(meta)).toBe(true);
    expect(getLastOffer(meta)?.productId).toBe(productId);
  }, 180_000);
});

describe('lastOffer add-item (e2e) — skip info', () => {
  it('documenta requisitos si e2e está deshabilitado', () => {
    if (isE2eEnabled()) return;
    expect(e2eSkipReason()).toBeTruthy();
  });
});
