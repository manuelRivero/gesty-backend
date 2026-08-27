/**
 * E2E: party-size → menú → carrito → checkout → fulfillment.
 *
 * Requiere: DATABASE_URL, PHONE_NUMBER_ID, OPENAI_API_KEY, menú con "ceviche".
 * Aserciones sobre estado/estructura (no copy del LLM); ver e2e/README.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  applyE2eEnv,
  e2eSkipReason,
  isE2eEnabled,
} from './helpers/env';
import {
  addItemViaButtonHappyPath,
  buildTextPayload,
  disconnectPrisma,
  findE2eAddableProduct,
  getConversationMetadata,
  getFreshConversationMetadata,
  hasHandlerResponse,
  isPartySizeGatePending,
  isPartySizeStored,
  isPartySizeUnset,
  loadMainGraph,
  looksLikeMenuResume,
  resetE2eCustomer,
  runGraphTurn,
  type MainGraph,
} from './helpers/graphHarness';

describe.sequential.skipIf(!isE2eEnabled())('party-size + checkout flow (e2e)', () => {
  let graph: MainGraph;
  let businessId: string;
  let conversationId: string;

  beforeAll(async () => {
    applyE2eEnv({ CHECKOUT_AGENT_ENABLED: 'true' });
    graph = await loadMainGraph();
    const reset = await resetE2eCustomer();
    businessId = reset.businessId;
    conversationId = reset.conversationId;
  }, 60_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('consulta de menú sin party size previo no persiste peopleCount', async () => {
    const { patchConversationMetadata, omitConversationMetadataKeys } = await import(
      '../src/repositories/conversationState.repository'
    );
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    await patchConversationMetadata(conversationId, {
      requestedPartySize: null,
      peopleCount: null,
      awaitingPartySize: false,
    });
    await omitConversationMetadataKeys(conversationId, ['peopleCountResume']);

    const state = await runGraphTurn(graph, buildTextPayload('Que onda con el ceviche ?'));
    const meta = await getFreshConversationMetadata(conversationId);

    expect(hasHandlerResponse(state.handlerResult)).toBe(true);
    expect(isPartySizeUnset(meta)).toBe(true);
  }, 120_000);

  it('reanuda menú tras responder party size', async () => {
    const s2 = await runGraphTurn(graph, buildTextPayload('somos 2'));
    const meta = getConversationMetadata(s2);

    expect(isPartySizeStored(meta, 2)).toBe(true);
    expect(meta?.awaitingPartySize).toBe(false);
    expect(meta?.peopleCountResume).toBeUndefined();
    expect(
      looksLikeMenuResume(s2.handlerResult, {
        lastReferencedProductId: s2.conversation?.lastReferencedProductId,
        intent: s2.detection?.intent ?? null,
      })
    ).toBe(true);
  }, 120_000);

  it('ADD_ITEM y checkout por texto no repreguntan party size', async () => {
    const product = await findE2eAddableProduct(businessId);
    await addItemViaButtonHappyPath({
      graph,
      businessId,
      productId: product.id,
    });

    const { prisma } = await import('../src/lib/prisma');
    const draftAfterAdd = await prisma.draft_order.findFirst({
      where: { business_id: businessId, status: 'active' },
      select: { draft_order_item: { select: { id: true } }, fulfillment_type: true },
    });
    expect(draftAfterAdd?.draft_order_item.length ?? 0).toBeGreaterThan(0);
    expect(draftAfterAdd?.fulfillment_type).toBeNull();

    const s3 = await runGraphTurn(graph, buildTextPayload('quiero finalizar el pedido'));
    const meta =
      (await getFreshConversationMetadata(conversationId)) ?? getConversationMetadata(s3);

    expect(meta?.checkout_active).toBe(true);
    expect(isPartySizeGatePending(meta)).toBe(false);
  }, 180_000);

  it('pregunta de producto no setea fulfillment sin checkout', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    const product = await findE2eAddableProduct(businessId);
    await addItemViaButtonHappyPath({
      graph,
      businessId,
      productId: product.id,
    });

    const { prisma } = await import('../src/lib/prisma');
    await prisma.draft_order.updateMany({
      where: { business_id: businessId, status: 'active' },
      data: { fulfillment_type: null },
    });

    const metaBefore = await getFreshConversationMetadata(conversationId);
    expect(metaBefore?.checkout_active).not.toBe(true);

    // "en casa" con carrito hoy puede abrir checkout (ver checkout-flow).
    // Acá validamos que una consulta de producto no escribe fulfillment.
    await runGraphTurn(graph, buildTextPayload('el ceviche es picante?'));

    const draftAfter = await prisma.draft_order.findFirst({
      where: { business_id: businessId, status: 'active' },
      select: { fulfillment_type: true },
    });
    expect(draftAfter?.fulfillment_type ?? null).toBeNull();

    const metaAfter = await getFreshConversationMetadata(conversationId);
    expect(metaAfter?.checkout_active).not.toBe(true);
  }, 120_000);
});

describe('party-size + checkout flow (e2e) — skip info', () => {
  it('documenta requisitos si e2e está deshabilitado', () => {
    if (isE2eEnabled()) return;
    expect(e2eSkipReason()).toBeTruthy();
  });
});
