/**
 * Auditoría de estado de una conversación: qué Facts vio el agente en el turno.
 *
 * Pensado para leer un log de WhatsApp y confirmar por qué el bot hizo lo que
 * hizo (cola de pedido, pendings tipables, party size, ledger de Intents,
 * carrito). Solo lectura.
 *
 * Uso:
 *   npm run inspect:conversation                      # teléfono de WHATSAPP_TEST_TO
 *   npm run inspect:conversation -- 5493413867990     # por teléfono
 *   npm run inspect:conversation -- <conversationId>  # por id de conversación
 *   npm run inspect:conversation -- <arg> --messages=20
 *   npm run inspect:conversation -- <arg> --raw       # metadata completa
 */
import 'dotenv/config';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const target = args.find((a) => !a.startsWith('--'));

const RAW = flags.includes('--raw');
const MESSAGES_LIMIT = (() => {
  const flag = flags.find((f) => f.startsWith('--messages='));
  const n = flag ? Number(flag.split('=')[1]) : 10;
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.floor(n)) : 10;
})();

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const line = (label: string, value: unknown): void => {
  console.log(`  ${label}: ${value ?? '—'}`);
};

const section = (title: string): void => {
  console.log(`\n── ${title} ──`);
};

async function main() {
  const { prisma } = await import('../src/lib/prisma');

  const phone = target && !UUID_RE.test(target) ? target : null;
  const conversationIdArg = target && UUID_RE.test(target) ? target : null;
  const fallbackPhone = process.env.WHATSAPP_TEST_TO ?? '5493413867990';

  let conversationId = conversationIdArg;

  if (!conversationId) {
    const phoneNumber = phone ?? fallbackPhone;
    const phoneNumberId = process.env.PHONE_NUMBER_ID ?? '';
    if (!phoneNumberId) {
      throw new Error('PHONE_NUMBER_ID no configurado en .env (o pasá el conversationId)');
    }
    const { findBusinessByPhoneNumberId } = await import(
      '../src/repositories/business.repository'
    );
    const business = await findBusinessByPhoneNumberId(phoneNumberId);
    if (!business) throw new Error(`Negocio no encontrado: ${phoneNumberId}`);

    const customer = await prisma.customer.findFirst({
      where: { business_id: business.id, phone_number: phoneNumber },
      select: { id: true },
    });
    if (!customer) throw new Error(`Cliente no encontrado: ${phoneNumber}`);

    const conv = await prisma.conversation.findFirst({
      where: { business_id: business.id, customer_id: customer.id },
      orderBy: { last_message_at: 'desc' },
      select: { id: true },
    });
    if (!conv) throw new Error(`Sin conversaciones para ${phoneNumber}`);
    conversationId = conv.id;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      status: true,
      last_message_at: true,
      lastReferencedProductId: true,
      business_id: true,
      customer: { select: { phone_number: true, name: true } },
    },
  });
  if (!conversation) throw new Error(`Conversación no encontrada: ${conversationId}`);

  const state = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { mode: true, metadata: true, updated_at: true },
  });
  const meta = isRecord(state?.metadata) ? state!.metadata : {};

  section('Conversación');
  line('id', conversation.id);
  line('cliente', `${conversation.customer?.phone_number ?? '?'} (${conversation.customer?.name ?? 'sin nombre'})`);
  line('status', conversation.status);
  line('último mensaje', conversation.last_message_at?.toISOString());
  line('mode', state?.mode);
  line('state actualizado', state?.updated_at?.toISOString());
  line('lastReferencedProductId', conversation.lastReferencedProductId);

  section('Cola de pedido (pendingOrderLines)');
  const queue = meta.pendingOrderLines;
  if (!isRecord(queue) || !Array.isArray(queue.lines)) {
    console.log('  sin cola — plan_order_lines no corrió o ya se vació');
  } else {
    line('sourceMessage', queue.sourceMessage);
    line('createdAt', queue.createdAt);
    for (const raw of queue.lines) {
      if (!isRecord(raw)) continue;
      const qty = raw.requestedQuantity == null ? 'sin cantidad' : `${raw.requestedQuantity}×`;
      console.log(`  · [${raw.status}] ${raw.hint} (${qty}) id=${raw.id}`);
    }
    const open = queue.lines.filter(
      (l) => isRecord(l) && (l.status === 'queued' || l.status === 'active')
    ).length;
    line('líneas abiertas', open);
    line(
      'efecto',
      open > 0
        ? 'COMPLETAR_PEDIDO y SUGERIR_COMPLEMENTO suprimidos (D7)'
        : 'sin supresión: el complemento puede aparecer'
    );
  }

  section('Pendings tipables');
  line('pendingProductSelection', meta.pendingProductSelection);
  line('pendingQuestion', meta.pendingQuestion);
  line(
    'candidateProductIds',
    Array.isArray(meta.candidateProductIds) ? meta.candidateProductIds.join(', ') : null
  );
  line('pendingVariation', JSON.stringify(meta.pendingVariation ?? null));
  line('pendingAddQuantity', JSON.stringify(meta.pendingAddQuantity ?? null));
  line('pendingItemNote', JSON.stringify(meta.pendingItemNote ?? null));
  line('pendingTipables', JSON.stringify(meta.pendingTipables ?? null));
  line('lastOffer', JSON.stringify(meta.lastOffer ?? null));
  line('lastCtaPayload', meta.lastCtaPayload);

  section('Party size / checkout');
  line('peopleCount', meta.peopleCount);
  line('requestedPartySize', meta.requestedPartySize);
  line('checkout_active', meta.checkout_active);

  section('Intent ledger');
  const ledger = isRecord(meta.intentLedger) ? meta.intentLedger : {};
  const keys = Object.keys(ledger);
  if (keys.length === 0) {
    console.log('  vacío');
  } else {
    for (const key of keys) {
      const entry = ledger[key];
      if (!isRecord(entry)) continue;
      console.log(
        `  · ${key}: surfaceCount=${entry.surfaceCount ?? 0} lastSurfacedAt=${
          entry.lastSurfacedAt ?? '—'
        }${entry.abandonment ? ' abandonment=true' : ''}${
          entry.refused ? ' refused=true' : ''
        }`
      );
    }
  }

  section('Carrito (draft activo)');
  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: conversation.business_id,
      customer_phone: conversation.customer?.phone_number ?? '',
      status: 'active',
    },
    select: {
      id: true,
      total_amount: true,
      fulfillment_type: true,
      expires_at: true,
      draft_order_item: {
        orderBy: { id: 'asc' },
        select: {
          quantity: true,
          variation: true,
          notes: true,
          menu_item: { select: { name: true } },
        },
      },
    },
  });
  if (!draft) {
    console.log('  sin draft activo');
  } else {
    line('id', draft.id);
    line('total', draft.total_amount?.toString());
    line('fulfillment', draft.fulfillment_type);
    line('expira', draft.expires_at?.toISOString());
    for (const item of draft.draft_order_item) {
      const extra = [item.variation, item.notes].filter(Boolean).join(' · ');
      console.log(
        `  · ${item.quantity}× ${item.menu_item?.name ?? '?'}${extra ? ` (${extra})` : ''}`
      );
    }
  }

  section(`Últimos ${MESSAGES_LIMIT} mensajes`);
  const messages = await prisma.conversation_message.findMany({
    where: { conversation_id: conversationId },
    orderBy: { created_at: 'desc' },
    take: MESSAGES_LIMIT,
    select: { created_at: true, sender: true, message: true },
  });
  for (const msg of messages.reverse()) {
    const when = msg.created_at?.toISOString().slice(11, 19) ?? '--:--:--';
    const preview = (msg.message ?? '').replace(/\n+/g, ' ⏎ ').slice(0, 160);
    console.log(`  [${when}] ${msg.sender}: ${preview}`);
  }

  if (RAW) {
    section('Metadata completa');
    console.log(JSON.stringify(meta, null, 2));
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
