/**
 * Prueba manual multi-turno del flujo party-size → menú → checkout → fulfillment.
 * Uso: npx tsx scripts/test-party-checkout-flow.ts
 */
import 'dotenv/config';

process.env.DRY_RUN_WHATSAPP_SEND = 'true';
process.env.AGENT_MODE = 'hybrid';
process.env.CHECKOUT_AGENT_ENABLED = 'true';

const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID ?? '';
const CUSTOMER_PHONE = process.env.WHATSAPP_TEST_TO ?? '5493413867990';

let msgCounter = 0;

async function main() {
  const { mainGraph } = await import('../src/graph/mainGraph');
  const { prisma } = await import('../src/lib/prisma');
  const { findBusinessByPhoneNumberId } = await import('../src/repositories/business.repository');
  const { patchConversationMetadata, omitConversationMetadataKeys } = await import(
    '../src/repositories/conversationState.repository'
  );
  const { updateCustomerName } = await import('../src/repositories');
  type AgentState = import('../src/graph/state').AgentState;
  type HandlerResult = import('../src/controllers/webhook/types').HandlerResult;
  type WhatsAppWebhookPayload = import('../src/controllers/webhook/types').WhatsAppWebhookPayload;
  const { MenuService } = await import('../src/services/menu.service');

  const buildTextPayload = (body: string): WhatsAppWebhookPayload => ({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              messages: [
                {
                  from: CUSTOMER_PHONE,
                  type: 'text',
                  id: `wamid.test-flow-${Date.now()}-${++msgCounter}`,
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const buildInteractivePayload = (replyId: string): WhatsAppWebhookPayload => ({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              messages: [
                {
                  from: CUSTOMER_PHONE,
                  type: 'interactive',
                  id: `wamid.test-flow-${Date.now()}-${++msgCounter}`,
                  interactive: {
                    type: 'button_reply',
                    button_reply: { id: replyId, title: replyId },
                  },
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const extractText = (result: HandlerResult | null | undefined): string => {
    if (!result) return '(sin respuesta)';
    const parts: string[] = [];
    const main =
      typeof result.content === 'string'
        ? result.content
        : JSON.stringify(result.content).slice(0, 200);
    parts.push(main);
    for (const fu of result.followUps ?? []) {
      if (fu.type === 'text' && fu.message) parts.push(`[followUp text] ${fu.message}`);
      if (fu.type === 'interactive') parts.push('[followUp interactive] botones');
    }
    return parts.join('\n---\n');
  };

  const runTurn = async (label: string, payload: WhatsAppWebhookPayload) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TURNO: ${label}`);
    console.log('='.repeat(60));
    const state = (await mainGraph.invoke({ webhookPayload: payload })) as AgentState;
    const meta = state.workingConversationState?.metadata as Record<string, unknown> | undefined;
    console.log('intent:', state.detection?.intent ?? '-');
    console.log('earlyExit:', state.earlyExit ?? '-');
    console.log('awaitingPartySize:', meta?.awaitingPartySize ?? '-');
    console.log('peopleCount:', meta?.peopleCount ?? meta?.requestedPartySize ?? '-');
    console.log('checkout_active:', meta?.checkout_active ?? '-');
    console.log('fulfillmentSelectionPending:', state.fulfillmentSelectionPending ?? false);
    console.log('\nRESPUESTA:\n', extractText(state.handlerResult));
    return state;
  };

  async function resetTestCustomer() {
    const business = await findBusinessByPhoneNumberId(PHONE_NUMBER_ID);
    if (!business) throw new Error(`Negocio no encontrado para phone_number_id=${PHONE_NUMBER_ID}`);

    const customer = await prisma.customer.findFirst({
      where: { business_id: business.id, phone_number: CUSTOMER_PHONE },
      select: { id: true },
    });
    if (!customer) return { businessId: business.id };

    await updateCustomerName(customer.id, '');
    const conv = await prisma.conversation.findFirst({
      where: { business_id: business.id, customer_id: customer.id, status: 'open' },
      select: { id: true },
    });
    if (conv) {
      await patchConversationMetadata(conv.id, {
        checkout_active: false,
        awaitingPeopleCount: false,
        awaitingPartySize: false,
        awaiting_name: false,
        pending_fulfillment_action: null,
        requestedPartySize: null,
        peopleCount: null,
      });
      await omitConversationMetadataKeys(conv.id, ['peopleCountResume']);
    }

    const draft = await prisma.draft_order.findFirst({
      where: { business_id: business.id, customer_phone: CUSTOMER_PHONE, status: 'active' },
      select: { id: true },
    });
    if (draft) {
      await prisma.draft_order_item.deleteMany({ where: { draft_order_id: draft.id } });
      await prisma.draft_order.update({
        where: { id: draft.id },
        data: { fulfillment_type: null, total_amount: 0 },
      });
    }

    return { businessId: business.id };
  }

  if (!PHONE_NUMBER_ID) {
    throw new Error('PHONE_NUMBER_ID no configurado en .env');
  }

  console.log('[test] reset estado de prueba…');
  const { businessId } = await resetTestCustomer();

  // 1) Consulta menú sin party size → debe pedir personas primero
  const s1 = await runTurn('¿ceviche? (sin party size)', buildTextPayload('Que onda con el ceviche ?'));
  const r1 = extractText(s1.handlerResult).toLowerCase();
  const meta1 = s1.workingConversationState?.metadata as Record<string, unknown> | undefined;
  const askedPartySize =
    r1.includes('cuánt') ||
    r1.includes('cuant') ||
    r1.includes('personas') ||
    r1.includes('cuántos') ||
    r1.includes('cuantos');
  const skippedMenuSearch = !r1.includes('opciones disponibles') && !r1.includes('tiradito');
  const deferredQuery = meta1?.awaitingPartySize === true;
  console.log('\n[assert 1] pide party size:', askedPartySize ? 'OK' : 'FAIL');
  console.log('[assert 1] no listó platos:', skippedMenuSearch ? 'OK' : 'FAIL');
  console.log('[assert 1] awaitingPartySize guardado:', deferredQuery ? 'OK' : 'FAIL');

  // 2) Party size → debe reanudar consulta de menú
  const s2 = await runTurn('somos 2', buildTextPayload('somos 2'));
  const r2 = extractText(s2.handlerResult).toLowerCase();
  const meta2 = s2.workingConversationState?.metadata as Record<string, unknown> | undefined;
  const answeredMenu =
    r2.includes('ceviche') || r2.includes('opciones disponibles') || r2.includes('tiradito');
  const partySizeSaved = meta2?.peopleCount === 2 || meta2?.requestedPartySize === 2;
  console.log('\n[assert 2] responde menú tras party size:', answeredMenu ? 'OK' : 'FAIL');
  console.log('[assert 2] party size persistido:', partySizeSaved ? 'OK' : 'FAIL');

  // 2b) Ítem en carrito (requerido para checkout por texto vía híbrido)
  const items = await MenuService.searchMenuItemsByKeyword({
    businessId,
    keyword: 'ceviche',
  });
  const product = items[0];
  if (!product) throw new Error('No hay producto ceviche en el menú de prueba');

  const s2b = await runTurn(
    'ADD_ITEM ceviche',
    buildInteractivePayload(`ADD_ITEM:${product.id}:1`)
  );
  const draftAfterAdd = await prisma.draft_order.findFirst({
    where: { business_id: businessId, customer_phone: CUSTOMER_PHONE, status: 'active' },
    select: { draft_order_item: { select: { id: true } }, fulfillment_type: true },
  });
  const hasCartItem = (draftAfterAdd?.draft_order_item.length ?? 0) > 0;
  const noFulfillmentPostAdd = draftAfterAdd?.fulfillment_type == null;
  console.log('\n[assert 2b] ítem en carrito:', hasCartItem ? 'OK' : 'FAIL');
  console.log('[assert 2b] sin fulfillment post-add:', noFulfillmentPostAdd ? 'OK' : 'FAIL');
  void s2b;

  // 3) Finalizar → híbrido delega al checkout agent
  const s3 = await runTurn('finalizar pedido', buildTextPayload('quiero finalizar el pedido'));
  const checkoutActive =
    (s3.workingConversationState?.metadata as Record<string, unknown> | undefined)
      ?.checkout_active === true;
  const r3 = extractText(s3.handlerResult).toLowerCase();
  const noRandomPartySize = !r3.includes('cuántas personas') && !r3.includes('para cuánt');
  console.log('\n[assert 3] checkout_active:', checkoutActive ? 'OK' : 'FAIL');
  console.log('[assert 3] no repregunta party size:', noRandomPartySize ? 'OK' : 'FAIL');

  // 4) Fulfillment en texto solo en checkout
  if (checkoutActive) {
    const s4 = await runTurn('en casa (checkout)', buildTextPayload('en casa'));
    const r4 = extractText(s4.handlerResult).toLowerCase();
    const draft = await prisma.draft_order.findFirst({
      where: {
        customer_phone: CUSTOMER_PHONE,
        status: 'active',
      },
      select: { fulfillment_type: true },
    });
    const fulfillmentSet = draft?.fulfillment_type === 'DELIVERY';
    const notPartySizeAgain = !r4.includes('cuántas personas');
    console.log('\n[assert 4] fulfillment_type=DELIVERY:', fulfillmentSet ? 'OK' : `FAIL (${draft?.fulfillment_type})`);
    console.log('[assert 4] no party size random:', notPartySizeAgain ? 'OK' : 'FAIL');
  } else {
    console.log('\n[assert 4] omitido (checkout no activo — carrito vacío?)');
  }

  // 5) "en casa" fuera de checkout → híbrido no debe setear fulfillment
  const convForReset = await prisma.conversation.findFirst({
    where: { customer: { phone_number: CUSTOMER_PHONE } },
    select: { id: true },
  });
  if (convForReset) {
    const { clearCheckoutSession } = await import('../src/graph/nodes/checkout/index');
    await clearCheckoutSession(convForReset.id);
  }
  await prisma.draft_order.updateMany({
    where: { customer_phone: CUSTOMER_PHONE, status: 'active' },
    data: { fulfillment_type: null },
  });

  const s5 = await runTurn('en casa (sin checkout)', buildTextPayload('en casa'));
  const draftAfter = await prisma.draft_order.findFirst({
    where: { customer_phone: CUSTOMER_PHONE, status: 'active' },
    select: { fulfillment_type: true },
  });
  const hybridNoFulfillment = draftAfter?.fulfillment_type == null;
  const checkoutOff =
    (s5.workingConversationState?.metadata as Record<string, unknown> | undefined)
      ?.checkout_active !== true;
  console.log('\n[assert 5] checkout inactivo:', checkoutOff ? 'OK' : 'FAIL');
  console.log('[assert 5] híbrido no setea fulfillment:', hybridNoFulfillment ? 'OK' : 'FAIL');

  await prisma.$disconnect();
  console.log('\n[test] fin');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
