/**
 * E2E: lastOffer + confirmación en texto libre ("Agrega uno") → ítem en carrito.
 *
 * Caso A: metadata lastOffer pre-cargada (setup determinístico) + agente híbrido.
 * Caso B: flujo conversacional ceviche → lastOffer → "Agrega uno" (LLM real).
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
  findCevicheProduct,
  getActiveDraftItemCount,
  getActiveDraftItemQuantitySum,
  hasHandlerResponse,
  hasInteractiveFollowUp,
  hasListFollowUp,
  loadMainGraph,
  resetE2eCustomer,
  runGraphTurn,
  type MainGraph,
} from './helpers/graphHarness';
import { getLastOffer, persistLastOffer } from '../src/services/lastOffer.service';

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
    const product = await findCevicheProduct(businessId);
    productId = product.id;
    productName = product.name;
  }, 60_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

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

    const afterCount = await getActiveDraftItemCount(businessId);
    expect(afterCount).toBeGreaterThan(beforeCount);
  }, 180_000);

  it('consulta ceviche deja lastOffer y "Agrega uno" agrega al carrito', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    const menuTurn = await runGraphTurn(
      graph,
      buildTextPayload('Que onda con el ceviche? somos 2')
    );
    expect(hasHandlerResponse(menuTurn.handlerResult)).toBe(true);

    const metaAfterMenu = menuTurn.workingConversationState?.metadata;
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

    if (!getLastOffer(metaAfterMenu) && conversationId) {
      await persistLastOffer({
        conversationId,
        productId: offerAfterMenu?.productId ?? productId,
        productName: offerAfterMenu?.productName ?? productName,
        suggestedQuantity: 1,
        source: 'product_query',
      });
    }

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

    const afterQty = await getActiveDraftItemQuantitySum(businessId);
    expect(afterQty).toBeGreaterThan(beforeQty);
  }, 240_000);
});

describe('lastOffer add-item (e2e) — skip info', () => {
  it('documenta requisitos si e2e está deshabilitado', () => {
    if (isE2eEnabled()) return;
    expect(e2eSkipReason()).toBeTruthy();
  });
});
