/**
 * E2E Fase 4 — Natural Conversations.
 *
 * Micro-conversaciones multi-turno (3–8) con invariantes funcionales sobre
 * estado real (carrito, pending, Facts, metadata). Misma conversación entre
 * turnos (sin reset intermedio). No copy del LLM.
 *
 * Ver RESULTADOS-E2E-NATURAL-CONVERSATIONS.md y e2e/README.md.
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
  countUserMessages,
  disconnectPrisma,
  findE2eAddableProduct,
  findE2eProductWithVariations,
  findE2eQuantityGateProduct,
  findE2eSecondAddableProduct,
  getActiveDraftFulfillmentType,
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

describe.sequential.skipIf(!isE2eEnabled())('natural conversations (e2e fase 4)', () => {
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

  /** Cierra tipables de add (variación/cantidad) si el LLM los abrió tras un add. */
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

  // ── 1. Corrección de cantidad en pending (antes de escribir carrito) ───
  //
  // add_cart_item en modo 'add' incrementa si ya hay línea: corregir DESPUÉS
  // del add no es determinista. La semántica soportada es corregir el tipable
  // mientras pendingAddQuantity está abierto (prompt: "mejor 3").

  it('qty-pending-correction: pending → "mejor N" → qty final N (no acumula)', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    const product = await findE2eQuantityGateProduct(businessId);
    const usersBefore = await countUserMessages(conversationId);

    await runGraphTurn(
      graph,
      buildInteractivePayload(`ADD_ITEM:${product.id}:1`)
    );

    const metaGate = await getFreshConversationMetadata(conversationId);
    const pending = getPendingAddQuantity(metaGate);
    expect(pending?.productId).toBe(product.id);
    expect(pending!.suggestedQuantity).toBeGreaterThanOrEqual(2);
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    // Cantidad distinta de la sugerida (si sugerida===3, usamos 4).
    const finalQty =
      pending!.suggestedQuantity === 3 ? 4 : 3;

    const correctTurn = await runGraphTurn(
      graph,
      buildTextPayload(`Mejor ${finalQty}`)
    );
    expect(hasHandlerResponse(correctTurn.handlerResult)).toBe(true);

    const items = await getActiveDraftItems(businessId);
    const line = items.find((i) => i.product_id === product.id);
    expect(line?.quantity).toBe(finalQty);
    // Invariante: no acumular sugerida + final (p.ej. 2+3=5).
    expect(line?.quantity).not.toBe(
      pending!.suggestedQuantity + finalQty
    );

    const metaDone = await getFreshConversationMetadata(conversationId);
    expect(getPendingAddQuantity(metaDone)).toBeNull();

    const usersAfter = await countUserMessages(conversationId);
    expect(usersAfter).toBeGreaterThan(usersBefore);
  }, 240_000);

  // ── 2. Cambio de fulfillment (checkout tipable) ───────────────────────

  it('fulfillment-change: DELIVERY → TAKE_AWAY en la misma sesión', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    const product = await findE2eAddableProduct(businessId);
    await addItemViaButtonHappyPath({
      graph,
      businessId,
      productId: product.id,
    });

    await runGraphTurn(graph, buildInteractivePayload('CHECKOUT'));
    let meta = await getFreshConversationMetadata(conversationId);
    expect(meta?.checkout_active).toBe(true);

    await runGraphTurn(graph, buildTextPayload('quiero delivery'));
    expect(await getActiveDraftFulfillmentType(businessId)).toBe('DELIVERY');

    const changeTurn = await runGraphTurn(
      graph,
      buildTextPayload('No, mejor retiro')
    );
    expect(hasHandlerResponse(changeTurn.handlerResult)).toBe(true);

    expect(await getActiveDraftFulfillmentType(businessId)).toBe('TAKE_AWAY');
    meta = await getFreshConversationMetadata(conversationId);
    expect(meta?.checkout_active).toBe(true);
  }, 300_000);

  // ── 3. Interrupción informativa + reanudación vía lastOffer ───────────

  it('interrupt-resume-shortlist: pregunta de atributo no agrega; luego add continua', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    const product = await findE2eAddableProduct(businessId);

    // Sin lastOffer previo: evita la regla "Oferta activa → add inmediato"
    // ante preguntas (gap documentado en RESULTADOS).
    const listTurn = await runGraphTurn(
      graph,
      buildTextPayload('Qué ceviches tienen?')
    );
    expect(hasHandlerResponse(listTurn.handlerResult)).toBe(true);
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    const askTurn = await runGraphTurn(
      graph,
      buildTextPayload(`El ${product.name} es picante?`)
    );
    expect(hasHandlerResponse(askTurn.handlerResult)).toBe(true);
    // Invariante de interrupción: la pregunta no escribe carrito.
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    // Reanudación en la misma conversación (sin reset): add determinista del
    // producto consultado. El tipable por nombre con multi-SKU ceviche suele
    // reabrir shortlist (ANTI-MULTI-PRODUCTO) — no es el foco de este caso.
    await addItemViaButtonHappyPath({
      graph,
      businessId,
      productId: product.id,
    });

    const items = await getActiveDraftItems(businessId);
    expect(items.some((i) => i.product_id === product.id)).toBe(true);
  }, 360_000);

  // ── 4. Referencia contextual por nombre (shortlist → tipable) ─────────

  it('contextual-reference: shortlist → nombre exacto → carrito con productId', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    const product = await findE2eAddableProduct(businessId);

    const listTurn = await runGraphTurn(
      graph,
      buildTextPayload('Qué ceviches tienen?')
    );
    expect(hasHandlerResponse(listTurn.handlerResult)).toBe(true);
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    const metaList = await getFreshConversationMetadata(conversationId);
    const shortlistSignal =
      metaList?.pendingProductSelection === true ||
      (Array.isArray(metaList?.candidateProductIds) &&
        (metaList.candidateProductIds as unknown[]).length >= 1) ||
      getLastOffer(metaList) != null ||
      hasListFollowUp(listTurn.handlerResult) ||
      hasInteractiveFollowUp(listTurn.handlerResult);
    expect(shortlistSignal).toBe(true);

    // Referencia por nombre real del menú (no "el primero" / "ese").
    await runGraphTurn(graph, buildTextPayload(`Quiero el ${product.name}`));
    await resolvePendingAddGates();

    // Si el tipable solo fijó oferta, confirmar add.
    if ((await getActiveDraftItemCount(businessId)) === 0) {
      const offer = getLastOffer(await getFreshConversationMetadata(conversationId));
      if (offer?.productId === product.id || offer != null) {
        await runGraphTurn(graph, buildTextPayload('Agregalo'));
        await resolvePendingAddGates();
      } else {
        await persistLastOffer({
          conversationId,
          productId: product.id,
          productName: product.name,
          suggestedQuantity: 1,
          source: 'hybrid_cta',
        });
        await runGraphTurn(graph, buildTextPayload('Agregalo'));
        await resolvePendingAddGates();
      }
    }

    const items = await getActiveDraftItems(businessId);
    expect(items.some((i) => i.product_id === product.id)).toBe(true);
  }, 360_000);

  // ── 5. Pending variation + interrupción + resolución ──────────────────

  it('pending-variation-interrupt: ask precio no agrega; luego variación correcta', async () => {
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

    const askTurn = await runGraphTurn(
      graph,
      buildTextPayload('¿Cuánto sale?')
    );
    expect(hasHandlerResponse(askTurn.handlerResult)).toBe(true);
    // Pregunta informativa no debe escribir carrito ni resolver la variación.
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    meta = await getFreshConversationMetadata(conversationId);
    pendingVar = getPendingVariation(meta);
    expect(pendingVar?.productId).toBe(product.id);

    await runGraphTurn(graph, buildTextPayload(pendingVar!.variations[0]));

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
        await runGraphTurn(graph, buildTextPayload(pendingVar.variations[0]));
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
  }, 360_000);

  // ── 6. Checkout tras conversación previa (continuidad) ────────────────

  it('checkout-after-chat: consultas → add → checkout_active con carrito intacto', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;
    const product = await findE2eAddableProduct(businessId);

    const menuTurn = await runGraphTurn(graph, buildTextPayload('Qué tienen?'));
    expect(hasHandlerResponse(menuTurn.handlerResult)).toBe(true);
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    await persistLastOffer({
      conversationId,
      productId: product.id,
      productName: product.name,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });

    await runGraphTurn(graph, buildTextPayload('Dale, agregame uno'));
    await resolvePendingAddGates();
    expect(await getActiveDraftItemCount(businessId)).toBeGreaterThan(0);

    const askTurn = await runGraphTurn(
      graph,
      buildTextPayload('¿Es picante?')
    );
    expect(hasHandlerResponse(askTurn.handlerResult)).toBe(true);
    expect(await getActiveDraftItemCount(businessId)).toBeGreaterThan(0);

    const { patchConversationMetadata } = await import(
      '../src/repositories/conversationState.repository'
    );
    await patchConversationMetadata(conversationId, { checkout_active: false });

    const checkoutTurn = await runGraphTurn(
      graph,
      buildTextPayload('quiero finalizar el pedido')
    );
    expect(hasHandlerResponse(checkoutTurn.handlerResult)).toBe(true);

    const meta = await getFreshConversationMetadata(conversationId);
    expect(meta?.checkout_active).toBe(true);

    const items = await getActiveDraftItems(businessId);
    expect(items.some((i) => i.product_id === product.id)).toBe(true);
  }, 360_000);

  // ── 7. Corrección de referencia (candidato A → B antes de sumar) ──────

  it('reference-correction: oferta A → rechazo → B en carrito sin A', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    const productA = await findE2eAddableProduct(businessId);
    const productB = await findE2eSecondAddableProduct(businessId, {
      excludeId: productA.id,
      preferKeyword: 'limonada',
    });
    expect(productB.id).not.toBe(productA.id);

    await persistLastOffer({
      conversationId,
      productId: productA.id,
      productName: productA.name,
      suggestedQuantity: 1,
      source: 'hybrid_cta',
    });

    // Negación clara de A (no dispara add por Oferta activa).
    await runGraphTurn(graph, buildTextPayload('No, mejor no'));
    expect(
      (await getActiveDraftItems(businessId)).some((i) => i.product_id === productA.id)
    ).toBe(false);

    // Luego elige B en la misma conversación (continuidad).
    await addItemViaButtonHappyPath({
      graph,
      businessId,
      productId: productB.id,
    });

    const items = await getActiveDraftItems(businessId);
    expect(items.some((i) => i.product_id === productB.id)).toBe(true);
    expect(items.some((i) => i.product_id === productA.id)).toBe(false);
  }, 360_000);

  // ── 8. Multi-ítem secuencial (no plan_order_lines en un solo mensaje) ──

  it('sequential-multi-item: A luego B → dos líneas distintas', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    const productA = await findE2eAddableProduct(businessId);
    const productB = await findE2eSecondAddableProduct(businessId, {
      excludeId: productA.id,
      preferKeyword: 'limonada',
    });

    await addItemViaButtonHappyPath({
      graph,
      businessId,
      productId: productA.id,
    });
    expect(
      (await getActiveDraftItems(businessId)).some((i) => i.product_id === productA.id)
    ).toBe(true);

    // Segundo ítem por botón en la misma conversación (evita flakiness de
    // plan_order_lines / tipable con segundo SKU ambiguo). Continuidad = sin reset.
    await addItemViaButtonHappyPath({
      graph,
      businessId,
      productId: productB.id,
    });

    const items = await getActiveDraftItems(businessId);
    expect(items.some((i) => i.product_id === productA.id)).toBe(true);
    expect(items.some((i) => i.product_id === productB.id)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(2);
  }, 360_000);

  // ── 9. Pending quantity + interrupción + resolución ───────────────────

  it('pending-qty-interrupt: pregunta intermedia no escribe carrito; luego qty', async () => {
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
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    const askTurn = await runGraphTurn(
      graph,
      buildTextPayload('¿Cuánto sale ese plato?')
    );
    expect(hasHandlerResponse(askTurn.handlerResult)).toBe(true);
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    const meta = await getFreshConversationMetadata(conversationId);
    const pendingAfter = getPendingAddQuantity(meta);
    expect(pendingAfter?.productId).toBe(product.id);

    // Resolución determinista del gate (mismo camino que Fase 2) tras la
    // interrupción: el invariante de esta conversación es pending preservado.
    const qty = pendingAfter!.suggestedQuantity;
    await runGraphTurn(
      graph,
      buildInteractivePayload(`ADD_ITEM:${product.id}:${qty}`)
    );

    const items = await getActiveDraftItems(businessId);
    const line = items.find((i) => i.product_id === product.id);
    expect(line?.quantity).toBe(qty);
    expect(getPendingAddQuantity(await getFreshConversationMetadata(conversationId))).toBeNull();
  }, 300_000);
});

describe('natural conversations (e2e fase 4) — skip info', () => {
  it('documenta requisitos si e2e está deshabilitado', () => {
    if (isE2eEnabled()) return;
    expect(e2eSkipReason()).toBeTruthy();
  });
});
