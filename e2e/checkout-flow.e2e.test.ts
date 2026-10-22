/**
 * E2E: checkout + fulfillment (botón CHECKOUT, delegación híbrido → checkout
 * por texto, party size → menú → checkout).
 *
 * Fusión de los antiguos `checkout-flow.e2e.test.ts` y
 * `party-checkout-flow.e2e.test.ts` (auditoría E2E, Fase 4): compartían
 * literalmente el tramo "agregar por botón → 'quiero finalizar el pedido' →
 * checkout_active" (mismo Contrato 10). Se conserva un solo caso para ese
 * tramo, con las aserciones de ambos originales combinadas.
 *
 * Happy path alineado al comportamiento actual:
 * - ADD_ITEM puede pedir variación / cantidad / confirm de cerrado (helpers).
 * - Checkout exige carrito con ítems → `checkout_active`.
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
  buildInteractivePayload,
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
    const product = await findE2eAddableProduct(businessId);
    productId = product.id;
  }, 60_000);

  afterAll(async () => {
    await disconnectPrisma();
  });

  it('ADD_ITEM por botón agrega al carrito sin fulfillment', async () => {
    await addItemViaButtonHappyPath({ graph, businessId, productId });

    const { prisma } = await import('../src/lib/prisma');
    const draft = await prisma.draft_order.findFirst({
      where: { business_id: businessId, status: 'active' },
      select: { fulfillment_type: true, draft_order_item: { select: { id: true } } },
    });
    expect(draft?.draft_order_item.length ?? 0).toBeGreaterThan(0);
    expect(draft?.fulfillment_type).toBeNull();
  }, 90_000);

  it('botón CHECKOUT activa sesión y acepta fulfillment en texto', async () => {
    await addItemViaButtonHappyPath({ graph, businessId, productId });

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
    // El invariante es "el bot no quedó esperando personas", no el valor de un
    // flag: `awaitingPartySize`/`peopleCountResume` se borraron con V-11.
    expect(isPartySizeGatePending(meta)).toBe(false);
    expect(
      looksLikeMenuResume(s2.handlerResult, {
        lastReferencedProductId: s2.conversation?.lastReferencedProductId,
        intent: s2.detection?.intent ?? null,
      })
    ).toBe(true);
  }, 120_000);

  it('"finalizar pedido" por texto activa checkout sin repreguntar party size', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    await addItemViaButtonHappyPath({ graph, businessId, productId });

    const { prisma } = await import('../src/lib/prisma');
    const draftAfterAdd = await prisma.draft_order.findFirst({
      where: { business_id: businessId, status: 'active' },
      select: { draft_order_item: { select: { id: true } }, fulfillment_type: true },
    });
    expect(draftAfterAdd?.draft_order_item.length ?? 0).toBeGreaterThan(0);
    expect(draftAfterAdd?.fulfillment_type).toBeNull();

    const { patchConversationMetadata } = await import(
      '../src/repositories/conversationState.repository'
    );
    await patchConversationMetadata(conversationId, { checkout_active: false });

    const state = await runGraphTurn(graph, buildTextPayload('quiero finalizar el pedido'));
    const meta =
      (await getFreshConversationMetadata(conversationId)) ??
      (state.workingConversationState?.metadata as Record<string, unknown> | undefined);

    expect(meta?.checkout_active).toBe(true);
    expect(isPartySizeGatePending(meta)).toBe(false);
    expect(state.detection?.intent).not.toBe('VIEW_CART');
    expect(state.detection?.intent).not.toBe('VIEW_CART_FOR_EDITION');
    // Nota de alcance (Fase 4.1): `extractHandlerText(...).length > 0` y
    // `hasHandlerResponse` demuestran lo mismo — que el bot devolvió algo
    // (texto o followUp), no que el contenido sea semánticamente correcto.
    // El cambio no es una mejora semántica: usa el helper canónico de la
    // suite en vez de una extracción de texto ad hoc con placeholders
    // ('[followUp list]'), evitando esa indirección, pero sigue siendo solo
    // una señal de "respondió algo". Lo que de verdad valida este caso es
    // `meta?.checkout_active`, `isPartySizeGatePending` y el intent !=
    // VIEW_CART* de arriba; esta línea es una comprobación secundaria.
    expect(hasHandlerResponse(state.handlerResult)).toBe(true);
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

    // "en casa" con carrito hoy puede abrir checkout (ver el caso de botón
    // CHECKOUT arriba). Acá validamos que una consulta de producto no
    // escribe fulfillment.
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

describe('checkout flow (e2e) — skip info', () => {
  it('documenta requisitos si e2e está deshabilitado', () => {
    if (isE2eEnabled()) return;
    expect(e2eSkipReason()).toBeTruthy();
  });
});
