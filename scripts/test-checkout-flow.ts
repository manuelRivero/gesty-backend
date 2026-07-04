/**
 * Prueba checkout + fulfillment con ítem en carrito.
 * Uso: CHECKOUT_AGENT_ENABLED=true npx tsx scripts/test-checkout-flow.ts
 */
import 'dotenv/config';

process.env.DRY_RUN_WHATSAPP_SEND = 'true';
process.env.AGENT_MODE = 'hybrid';
process.env.CHECKOUT_AGENT_ENABLED = 'true';

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID ?? '';
const CUSTOMER_PHONE = process.env.WHATSAPP_TEST_TO ?? '5493413867990';
let msgCounter = 0;

async function main() {
  const { prisma } = await import('../src/lib/prisma');
  const { mainGraph } = await import('../src/graph/mainGraph');
  type AgentState = import('../src/graph/state').AgentState;
  type WhatsAppWebhookPayload = import('../src/controllers/webhook/types').WhatsAppWebhookPayload;
  const { findBusinessByPhoneNumberId } = await import('../src/repositories/business.repository');
  const { MenuService } = await import('../src/services/menu.service');

  const payload = (body: string): WhatsAppWebhookPayload => ({
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: PHONE_NUMBER_ID },
          messages: [{
            from: CUSTOMER_PHONE,
            type: 'text',
            id: `wamid.co-${Date.now()}-${++msgCounter}`,
            text: { body },
          }],
        },
      }],
    }],
  });

  const interactive = (replyId: string): WhatsAppWebhookPayload => ({
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: PHONE_NUMBER_ID },
          messages: [{
            from: CUSTOMER_PHONE,
            type: 'interactive',
            id: `wamid.co-${Date.now()}-${++msgCounter}`,
            interactive: {
              type: 'button_reply',
              button_reply: { id: replyId, title: replyId },
            },
          }],
        },
      }],
    }],
  });

  const run = async (label: string, p: WhatsAppWebhookPayload) => {
    console.log(`\n--- ${label} ---`);
    const s = (await mainGraph.invoke({ webhookPayload: p })) as AgentState;
    const meta = s.workingConversationState?.metadata as Record<string, unknown> | undefined;
    console.log('intent:', s.detection?.intent);
    console.log('checkout_active:', meta?.checkout_active);
    console.log('fulfillmentSelectionPending:', s.fulfillmentSelectionPending);
    const content = s.handlerResult?.content
      ? (typeof s.handlerResult.content === 'string'
          ? s.handlerResult.content.slice(0, 280)
          : JSON.stringify(s.handlerResult.content).slice(0, 280))
      : '(sin respuesta)';
    console.log('resp:', content.replace(/\n/g, ' '));
    return s;
  };

  const business = await findBusinessByPhoneNumberId(PHONE_NUMBER_ID);
  if (!business) throw new Error('business not found');

  const items = await MenuService.searchMenuItemsByKeyword({
    businessId: business.id,
    keyword: 'ceviche',
  });
  const product = items[0];
  if (!product) throw new Error('no ceviche product');

  const customer = await prisma.customer.findFirst({
    where: { business_id: business.id, phone_number: CUSTOMER_PHONE },
  });
  const conv = customer
    ? await prisma.conversation.findFirst({
        where: { business_id: business.id, customer_id: customer.id },
        orderBy: { started_at: 'desc' },
      })
    : null;

  if (conv) {
    const { patchConversationMetadata } = await import('../src/repositories/conversationState.repository');
    await patchConversationMetadata(conv.id, {
      checkout_active: false,
      requestedPartySize: 2,
      peopleCount: 2,
      pending_fulfillment_action: null,
    });
  }

  await run('ADD_ITEM', interactive(`ADD_ITEM:${product.id}:1`));

  const afterAdd = await prisma.draft_order.findFirst({
    where: { business_id: business.id, customer_phone: CUSTOMER_PHONE, status: 'active' },
    select: { fulfillment_type: true, draft_order_item: { select: { id: true } } },
  });
  console.log('\n[post-add] items:', afterAdd?.draft_order_item.length, 'fulfillment:', afterAdd?.fulfillment_type);
  console.log('[post-add] sin botones fulfillment:', afterAdd?.fulfillment_type == null ? 'OK' : 'FAIL');

  await run('CHECKOUT botón', interactive('CHECKOUT'));

  const afterCheckoutBtn = await prisma.conversation_state.findFirst({
    where: { conversation_id: conv?.id },
    select: { metadata: true },
  });
  const checkoutActiveBtn =
    (afterCheckoutBtn?.metadata as Record<string, unknown>)?.checkout_active === true;
  console.log('\n[checkout botón] sesión activa:', checkoutActiveBtn ? 'OK' : 'FAIL');

  if (checkoutActiveBtn) {
    await run('en casa (botón checkout)', payload('en casa'));
    const draft = await prisma.draft_order.findFirst({
      where: { business_id: business.id, customer_phone: CUSTOMER_PHONE, status: 'active' },
      select: { fulfillment_type: true },
    });
    console.log(
      '\n[fulfillment botón] type:',
      draft?.fulfillment_type,
      draft?.fulfillment_type === 'DELIVERY' ? 'OK' : 'FAIL'
    );
  }

  // Reset checkout para probar delegación híbrido → checkout por texto
  if (conv) {
    const { patchConversationMetadata } = await import('../src/repositories/conversationState.repository');
    await patchConversationMetadata(conv.id, { checkout_active: false });
  }

  const sTextCheckout = await run('finalizar pedido (texto)', payload('quiero finalizar el pedido'));
  const metaText = sTextCheckout.workingConversationState?.metadata as Record<string, unknown> | undefined;
  const checkoutActiveText = metaText?.checkout_active === true;
  console.log('\n[checkout texto] sesión activa:', checkoutActiveText ? 'OK' : 'FAIL');
  console.log(
    '[checkout texto] intent fue híbrido (no VIEW_CART closed):',
    sTextCheckout.detection?.intent !== 'VIEW_CART' &&
      sTextCheckout.detection?.intent !== 'VIEW_CART_FOR_EDITION'
      ? 'OK'
      : `FAIL (${sTextCheckout.detection?.intent})`
  );

  if (checkoutActiveText) {
    await run('en casa (texto checkout)', payload('en casa'));
    const draftText = await prisma.draft_order.findFirst({
      where: { business_id: business.id, customer_phone: CUSTOMER_PHONE, status: 'active' },
      select: { fulfillment_type: true },
    });
    console.log(
      '\n[fulfillment texto] type:',
      draftText?.fulfillment_type,
      draftText?.fulfillment_type === 'DELIVERY' ? 'OK' : 'FAIL'
    );
  }

  await prisma.$disconnect();
  console.log('\n[test] fin');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
