/**
 * E2E Fase 2 — Critical Agent Gates.
 *
 * Cubre gates tipables/sesión sin convertir el smoke happy path (Fase 1) en
 * suite de edge cases. Aserciones sobre efectos (carrito, metadata, Order),
 * no copy del LLM. Ver e2e/README.md.
 *
 * Contradicciones documentadas vs ideal:
 * - Botón ADD_ITEM sin :vN usa lista WA; no setea `pendingVariation` (eso es híbrido).
 * - Gate de local cerrado solo en interactive ADD_ITEM (no en add_cart_item).
 * - Pago E2E usa el primer método ofrecido (hoy transfer); no asume cash.
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
  findLatestOrderForE2eCustomer,
  forceBusinessClosedForE2e,
  getActiveDraftItemCount,
  getActiveDraftItems,
  getFreshConversationMetadata,
  getOfferedE2ePayButtonId,
  hasHandlerResponse,
  loadMainGraph,
  resetE2eCustomer,
  runGraphTurn,
  type MainGraph,
} from './helpers/graphHarness';
import { getPendingAddQuantity } from '../src/services/pendingAddQuantity.service';
import { getPendingVariation } from '../src/services/pendingVariation.service';
import { persistLastOffer } from '../src/services/lastOffer.service';
import {
  CANCEL_CLOSED_ORDER,
  CONFIRM_CLOSED_ORDER,
} from '../src/services/businessHours.service';

describe.sequential.skipIf(!isE2eEnabled())('agent gates (e2e fase 2)', () => {
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

  it('CHECKOUT con carrito vacío no activa sesión ni crea Order', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    const beforeOrders = await findLatestOrderForE2eCustomer(businessId);
    const beforeOrderId = beforeOrders?.id ?? null;

    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    const turn = await runGraphTurn(graph, buildInteractivePayload('CHECKOUT'));
    expect(hasHandlerResponse(turn.handlerResult)).toBe(true);

    const meta = await getFreshConversationMetadata(conversationId);
    expect(meta?.checkout_active).not.toBe(true);

    const draft = await (
      await import('../src/lib/prisma')
    ).prisma.draft_order.findFirst({
      where: {
        business_id: businessId,
        customer_phone: E2E_CUSTOMER_PHONE,
        status: 'active',
      },
      select: { fulfillment_type: true, payment_method: true },
    });
    expect(draft?.fulfillment_type ?? null).toBeNull();
    expect(draft?.payment_method ?? null).toBeNull();

    const after = await findLatestOrderForE2eCustomer(businessId);
    expect(after?.id ?? null).toBe(beforeOrderId);
  }, 90_000);

  it('local cerrado: confirma → flag + ítem; rechaza → sin carrito ni Order', async () => {
    const { getBusinessConfig } = await import('../src/services/businessConfig.service');
    const cfg = await getBusinessConfig(businessId);
    if (!cfg.operate_when_closed || !cfg.orders_when_closed) {
      throw new Error(
        'Negocio e2e sin operate_when_closed + orders_when_closed; no se puede ejercitar el gate'
      );
    }

    const closed = await forceBusinessClosedForE2e(businessId);
    try {
      const product = await findE2eAddableProduct(businessId);

      // Caso A — confirma
      let reset = await resetE2eCustomer({ confirmClosedOrder: false });
      conversationId = reset.conversationId;

      const addTurn = await runGraphTurn(
        graph,
        buildInteractivePayload(`ADD_ITEM:${product.id}:1`)
      );
      expect(hasHandlerResponse(addTurn.handlerResult)).toBe(true);

      let meta = await getFreshConversationMetadata(conversationId);
      expect(meta?.pending_closed_add_item).toBe(`ADD_ITEM:${product.id}:1`);
      expect(meta?.closed_order_confirmed_at).toBeFalsy();
      expect(await getActiveDraftItemCount(businessId)).toBe(0);

      const confirmTurn = await runGraphTurn(
        graph,
        buildInteractivePayload(CONFIRM_CLOSED_ORDER)
      );
      expect(hasHandlerResponse(confirmTurn.handlerResult)).toBe(true);

      meta = await getFreshConversationMetadata(conversationId);
      expect(typeof meta?.closed_order_confirmed_at).toBe('string');
      expect(meta?.pending_closed_add_item).toBeFalsy();
      expect(await getActiveDraftItemCount(businessId)).toBeGreaterThan(0);

      // Caso B — rechaza
      reset = await resetE2eCustomer({ confirmClosedOrder: false });
      conversationId = reset.conversationId;
      const beforeOrderId =
        (await findLatestOrderForE2eCustomer(businessId))?.id ?? null;

      await runGraphTurn(graph, buildInteractivePayload(`ADD_ITEM:${product.id}:1`));
      meta = await getFreshConversationMetadata(conversationId);
      expect(meta?.pending_closed_add_item).toBe(`ADD_ITEM:${product.id}:1`);

      const cancelTurn = await runGraphTurn(
        graph,
        buildInteractivePayload(CANCEL_CLOSED_ORDER)
      );
      expect(hasHandlerResponse(cancelTurn.handlerResult)).toBe(true);

      meta = await getFreshConversationMetadata(conversationId);
      expect(meta?.pending_closed_add_item).toBeFalsy();
      expect(meta?.closed_order_confirmed_at).toBeFalsy();
      expect(await getActiveDraftItemCount(businessId)).toBe(0);
      expect((await findLatestOrderForE2eCustomer(businessId))?.id ?? null).toBe(
        beforeOrderId
      );
    } finally {
      await closed.restore();
    }
  }, 180_000);

  it('quantity gate: pendingAddQuantity antes del carrito y qty correcta al resolver', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    const product = await findE2eQuantityGateProduct(businessId);
    const addTurn = await runGraphTurn(
      graph,
      buildInteractivePayload(`ADD_ITEM:${product.id}:1`)
    );
    expect(hasHandlerResponse(addTurn.handlerResult)).toBe(true);

    const metaAfterGate = await getFreshConversationMetadata(conversationId);
    const pending = getPendingAddQuantity(metaAfterGate);
    expect(pending?.productId).toBe(product.id);
    expect(pending?.suggestedQuantity).toBeGreaterThanOrEqual(2);
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

    const qty = pending!.suggestedQuantity;
    const resolveTurn = await runGraphTurn(
      graph,
      buildInteractivePayload(`ADD_ITEM:${product.id}:${qty}`)
    );
    expect(hasHandlerResponse(resolveTurn.handlerResult)).toBe(true);

    const items = await getActiveDraftItems(businessId);
    expect(items.length).toBeGreaterThan(0);
    const line = items.find((i) => i.product_id === product.id);
    expect(line?.quantity).toBe(qty);

    const metaDone = await getFreshConversationMetadata(conversationId);
    expect(getPendingAddQuantity(metaDone)).toBeNull();
  }, 120_000);

  it('variation gate (híbrido): pendingVariation sin carrito; luego ítem con variación', async () => {
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

    const offerTurn = await runGraphTurn(graph, buildTextPayload('Agrega uno'));
    expect(hasHandlerResponse(offerTurn.handlerResult)).toBe(true);

    let meta = await getFreshConversationMetadata(conversationId);
    let pendingVar = getPendingVariation(meta);

    // El gate tipable debe persistir pendingVariation ANTES de escribir carrito.
    // Si el LLM ya resolvió variación+qty en un solo add, no ejercitamos el gate → fail.
    expect(pendingVar?.productId).toBe(product.id);
    expect(await getActiveDraftItemCount(businessId)).toBe(0);

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
    const normalizedExpected = expectedVariation
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\.$/, '')
      .toLowerCase()
      .trim();
    const normalizedGot = (line!.variation ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\.$/, '')
      .toLowerCase()
      .trim();
    expect(normalizedGot).toContain(normalizedExpected.slice(0, 10));
    expect(getPendingVariation(meta)).toBeNull();
    expect(getPendingAddQuantity(meta)).toBeNull();
  }, 240_000);

  it('checkout completo con pago ofrecido crea Order real en BD', async () => {
    const reset = await resetE2eCustomer();
    conversationId = reset.conversationId;

    const product = await findE2eAddableProduct(businessId);
    await addItemViaButtonHappyPath({ graph, businessId, productId: product.id });
    expect(await getActiveDraftItemCount(businessId)).toBeGreaterThan(0);

    const beforeOrderId =
      (await findLatestOrderForE2eCustomer(businessId))?.id ?? null;
    const { buttonId: payButtonId, methodId } =
      await getOfferedE2ePayButtonId(businessId);

    const checkoutTurn = await runGraphTurn(
      graph,
      buildInteractivePayload('CHECKOUT')
    );
    expect(hasHandlerResponse(checkoutTurn.handlerResult)).toBe(true);

    let meta = await getFreshConversationMetadata(conversationId);
    expect(meta?.checkout_active).toBe(true);

    await runGraphTurn(graph, buildInteractivePayload('FULFILLMENT_TAKE_AWAY'));

    const { prisma } = await import('../src/lib/prisma');
    let draft = await prisma.draft_order.findFirst({
      where: {
        business_id: businessId,
        customer_phone: E2E_CUSTOMER_PHONE,
        status: 'active',
      },
      select: { fulfillment_type: true, payment_method: true },
    });
    expect(draft?.fulfillment_type).toBe('TAKE_AWAY');

    await runGraphTurn(graph, buildInteractivePayload(payButtonId));
    draft = await prisma.draft_order.findFirst({
      where: {
        business_id: businessId,
        customer_phone: E2E_CUSTOMER_PHONE,
        status: 'active',
      },
      select: { fulfillment_type: true, payment_method: true },
    });
    expect(draft?.payment_method).toBe(methodId);

    const confirmTurn = await runGraphTurn(
      graph,
      buildInteractivePayload('CONFIRM_ORDER')
    );
    expect(hasHandlerResponse(confirmTurn.handlerResult)).toBe(true);

    const order = await findLatestOrderForE2eCustomer(businessId);
    expect(order).toBeTruthy();
    expect(order!.id).not.toBe(beforeOrderId);
    expect(order!.status).toBe('placed');
    expect(order!.payment_status).toBe('unpaid');
    expect(order!.payment_method).toBe(methodId);
    expect(order!.fulfillment_type).toBe('TAKE_AWAY');
    expect(order!.order_item.length).toBeGreaterThan(0);

    const converted = await prisma.draft_order.findFirst({
      where: {
        business_id: businessId,
        customer_phone: E2E_CUSTOMER_PHONE,
        status: 'converted',
      },
      orderBy: { updated_at: 'desc' },
      select: { id: true },
    });
    expect(converted).toBeTruthy();

    // Tras Order la conversación se cierra; metadata de checkout en la nueva/reabierta
    // se limpia en el siguiente reset. Aquí verificamos sesión de la conversación usada:
    meta = await getFreshConversationMetadata(conversationId);
    expect(meta?.checkout_active).not.toBe(true);
  }, 240_000);
});

describe('agent gates (e2e fase 2) — skip info', () => {
  it('documenta requisitos si e2e está deshabilitado', () => {
    if (isE2eEnabled()) return;
    expect(e2eSkipReason()).toBeTruthy();
  });
});
