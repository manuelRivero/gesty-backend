/**
 * Limpia metadata de sesión y carrito para un cliente de prueba / staging.
 * Uso: npx tsx scripts/reset-conversation-state.ts [phone]
 */
import 'dotenv/config';

const PHONE = process.argv[2] ?? process.env.WHATSAPP_TEST_TO ?? '5493413867990';
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID ?? '';

async function main() {
  if (!PHONE_NUMBER_ID) {
    throw new Error('PHONE_NUMBER_ID no configurado en .env');
  }

  const { prisma } = await import('../src/lib/prisma');
  const { findBusinessByPhoneNumberId } = await import('../src/repositories/business.repository');
  const { patchConversationMetadata, omitConversationMetadataKeys } = await import(
    '../src/repositories/conversationState.repository'
  );
  const { clearCheckoutSession } = await import('../src/graph/nodes/checkout/index');

  const business = await findBusinessByPhoneNumberId(PHONE_NUMBER_ID);
  if (!business) throw new Error(`Negocio no encontrado: ${PHONE_NUMBER_ID}`);

  const customer = await prisma.customer.findFirst({
    where: { business_id: business.id, phone_number: PHONE },
    select: { id: true, phone_number: true },
  });
  if (!customer) {
    console.log(`[reset] cliente no encontrado: ${PHONE}`);
    return;
  }

  const conv = await prisma.conversation.findFirst({
    where: { business_id: business.id, customer_id: customer.id, status: 'open' },
    select: { id: true },
  });

  if (conv) {
    await clearCheckoutSession(conv.id);
    await patchConversationMetadata(conv.id, {
      awaitingPeopleCount: false,
      awaitingPartySize: false,
      awaiting_name: false,
      pending_fulfillment_action: null,
      requestedPartySize: null,
      peopleCount: null,
      reservation_agent_active: false,
    });
    await omitConversationMetadataKeys(conv.id, [
      'peopleCountResume',
      'reservation_draft',
      'pendingProductSelection',
      'candidateProductIds',
      'lastCtaPayload',
      'lastCtaShownAt',
      'lastCtaProductId',
    ]);
    console.log(`[reset] conversación limpiada: ${conv.id}`);
  }

  const draft = await prisma.draft_order.findFirst({
    where: { business_id: business.id, customer_phone: PHONE, status: 'active' },
    select: { id: true },
  });
  if (draft) {
    await prisma.draft_order_item.deleteMany({ where: { draft_order_id: draft.id } });
    await prisma.draft_order.update({
      where: { id: draft.id },
      data: { fulfillment_type: null, total_amount: 0 },
    });
    console.log(`[reset] draft vaciado: ${draft.id}`);
  }

  const state = conv
    ? await prisma.conversation_state.findFirst({
        where: { conversation_id: conv.id },
        select: { metadata: true },
      })
    : null;
  console.log('[reset] metadata final:', JSON.stringify(state?.metadata ?? {}, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
