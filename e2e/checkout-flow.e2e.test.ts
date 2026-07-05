/**
 * E2E: checkout + fulfillment (botón CHECKOUT y delegación híbrido → checkout por texto).
 *
 * Requiere: DATABASE_URL, PHONE_NUMBER_ID, OPENAI_API_KEY, menú con "ceviche".
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyE2eEnv,
  e2eSkipReason,
  isE2eEnabled,
} from './helpers/env';
import {
  buildInteractivePayload,
  buildTextPayload,
  disconnectPrisma,
  extractHandlerText,
  findCevicheProduct,
  getFreshConversationMetadata,
  hasHandlerResponse,
  loadMainGraph,
  resetE2eCustomer,
  runGraphTurn,
  type MainGraph,
} from './helpers/graphHarness';

describe.sequential.skipIf(!isE2eEnabled())('checkout flow (e2e)', () => {
  let graph: MainGraph;
  let businessId: string;
  let conversationId: string;
  let productId: string;

  beforeAll(async () => {
    applyE2eEnv({ CHECKOUT_AGENT_ENABLED: 'true' });
    graph = await loadMainGraph();
    const reset = await resetE2eCustomer();
    businessId = reset.businessId;
    conversationId = reset.conversationId;
    const product = await findCevicheProduct(businessId);
    productId = product.id;
  }, 60_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('ADD_ITEM por botón agrega al carrito sin fulfillment', async () => {
    const state = await runGraphTurn(
      graph,
      buildInteractivePayload(`ADD_ITEM:${productId}:1`)
    );
    expect(state.handlerResult).toBeTruthy();

    const { prisma } = await import('../src/lib/prisma');
    const draft = await prisma.draft_order.findFirst({
      where: { business_id: businessId, status: 'active' },
      select: { fulfillment_type: true, draft_order_item: { select: { id: true } } },
    });
    expect(draft?.draft_order_item.length ?? 0).toBeGreaterThan(0);
    expect(draft?.fulfillment_type).toBeNull();
  }, 90_000);

  it('botón CHECKOUT activa sesión y acepta fulfillment en texto', async () => {
    await runGraphTurn(graph, buildInteractivePayload(`ADD_ITEM:${productId}:1`));

    const checkoutTurn = await runGraphTurn(graph, buildInteractivePayload('CHECKOUT'));
    expect(hasHandlerResponse(checkoutTurn.handlerResult)).toBe(true);

    const checkoutMeta = await getFreshConversationMetadata(conversationId);
    const checkoutSessionStarted =
      checkoutMeta?.checkout_active === true ||
      checkoutTurn.handlerResult?.followUps?.some((fu) => fu.type === 'interactive') === true;
    expect(checkoutSessionStarted).toBe(true);

    const fulfillmentTurn = await runGraphTurn(graph, buildTextPayload('en casa'));
    expect(hasHandlerResponse(fulfillmentTurn.handlerResult)).toBe(true);

    const { prisma } = await import('../src/lib/prisma');
    const draft = await prisma.draft_order.findFirst({
      where: { business_id: businessId, status: 'active' },
      select: { fulfillment_type: true },
    });
    expect(draft?.fulfillment_type).toBe('DELIVERY');
  }, 120_000);

  it('"finalizar pedido" delega al checkout agent por texto', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    await runGraphTurn(graph, buildInteractivePayload(`ADD_ITEM:${productId}:1`));

    const { patchConversationMetadata } = await import(
      '../src/repositories/conversationState.repository'
    );
    if (conversationId) {
      await patchConversationMetadata(conversationId, { checkout_active: false });
    }

    const state = await runGraphTurn(graph, buildTextPayload('quiero finalizar el pedido'));
    const meta = state.workingConversationState?.metadata as Record<string, unknown> | undefined;
    expect(meta?.checkout_active).toBe(true);
    expect(state.detection?.intent).not.toBe('VIEW_CART');
    expect(state.detection?.intent).not.toBe('VIEW_CART_FOR_EDITION');
    expect(extractHandlerText(state.handlerResult).length).toBeGreaterThan(0);
  }, 120_000);
});

describe('checkout flow (e2e) — skip info', () => {
  it('documenta requisitos si e2e está deshabilitado', () => {
    if (isE2eEnabled()) return;
    expect(e2eSkipReason()).toBeTruthy();
  });
});
