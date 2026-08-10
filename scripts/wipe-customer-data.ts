/**
 * Borra por completo el estado de un cliente WhatsApp (conversaciones, pedidos,
 * drafts, reservas, comprobantes, payment intents) para que el bot arranque limpio.
 *
 * Uso:
 *   npx tsx scripts/wipe-customer-data.ts 3413867990           # dry-run (solo lista)
 *   npx tsx scripts/wipe-customer-data.ts 3413867990 --execute # borra de verdad
 *
 * Busca variantes de teléfono (549…, 54…, con/sin +) por endsWith del sufijo dado.
 * Scope: negocio de PHONE_NUMBER_ID del .env (si falta, busca en todos los negocios).
 */
import 'dotenv/config';

const args = process.argv.slice(2).filter((a) => a !== '--execute');
const EXECUTE = process.argv.includes('--execute');
const PHONE_INPUT = (args[0] ?? process.env.WHATSAPP_TEST_TO ?? '3413867990').replace(/\D/g, '');
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID ?? '';

function phoneVariants(digits: string): string[] {
  const bare = digits.replace(/^0+/, '');
  const candidates = new Set<string>([
    bare,
    `9${bare}`,
    `54${bare}`,
    `549${bare}`,
    `+${bare}`,
    `+54${bare}`,
    `+549${bare}`,
  ]);
  // Si ya viene con 549…, también probar sin el 9 móvil
  if (bare.startsWith('549') && bare.length >= 12) {
    candidates.add(`54${bare.slice(3)}`);
    candidates.add(bare.slice(3)); // área+número
  }
  if (bare.startsWith('54') && !bare.startsWith('549') && bare.length >= 11) {
    candidates.add(`549${bare.slice(2)}`);
  }
  return [...candidates];
}

function phoneSuffix(digits: string): string {
  // últimos 10 dígitos (área+número AR típico) para endsWith flexible
  const bare = digits.replace(/^0+/, '');
  if (bare.startsWith('549')) return bare.slice(3);
  if (bare.startsWith('54')) return bare.slice(2).replace(/^9/, '');
  return bare.slice(-10);
}

async function main() {
  const { prisma } = await import('../src/lib/prisma');
  const { findBusinessByPhoneNumberId } = await import('../src/repositories/business.repository');

  const variants = phoneVariants(PHONE_INPUT);
  const suffix = phoneSuffix(PHONE_INPUT);

  let businessId: string | null = null;
  if (PHONE_NUMBER_ID) {
    const business = await findBusinessByPhoneNumberId(PHONE_NUMBER_ID);
    if (business) {
      businessId = business.id;
      console.log(`[wipe] negocio: ${business.id} (PHONE_NUMBER_ID=${PHONE_NUMBER_ID})`);
    } else {
      console.warn(
        `[wipe] negocio no encontrado para PHONE_NUMBER_ID=${PHONE_NUMBER_ID} → buscando en todos los negocios`,
      );
    }
  } else {
    console.log('[wipe] PHONE_NUMBER_ID no configurado → buscando en todos los negocios');
  }

  console.log(`[wipe] input=${PHONE_INPUT} suffix=${suffix}`);
  console.log(`[wipe] variantes exactas: ${variants.join(', ')}`);
  console.log(`[wipe] modo: ${EXECUTE ? 'EXECUTE (borra)' : 'DRY-RUN (solo lista)'}`);

  const customers = await prisma.customer.findMany({
    where: {
      ...(businessId ? { business_id: businessId } : {}),
      OR: [
        { phone_number: { in: variants } },
        { phone_number: { endsWith: suffix } },
      ],
    },
    select: {
      id: true,
      business_id: true,
      phone_number: true,
      name: true,
      created_at: true,
    },
  });

  if (customers.length === 0) {
    // Aún así buscar drafts huérfanos por teléfono
    const orphanDrafts = await prisma.draft_order.findMany({
      where: {
        ...(businessId ? { business_id: businessId } : {}),
        OR: [
          { customer_phone: { in: variants } },
          { customer_phone: { endsWith: suffix } },
        ],
      },
      select: { id: true, customer_phone: true, status: true, business_id: true },
    });
    if (orphanDrafts.length === 0) {
      console.log('[wipe] no se encontró customer ni draft_order para ese teléfono');
      await prisma.$disconnect();
      return;
    }
    console.log(`[wipe] sin customer, pero hay ${orphanDrafts.length} draft(s) huérfano(s):`);
    for (const d of orphanDrafts) console.log('  -', d);
    if (EXECUTE) {
      await wipeDrafts(prisma, orphanDrafts.map((d) => d.id));
      console.log('[wipe] drafts huérfanos eliminados');
    }
    await prisma.$disconnect();
    return;
  }

  console.log(`[wipe] customers encontrados: ${customers.length}`);
  for (const c of customers) {
    console.log(
      `  - id=${c.id} phone=${c.phone_number} name=${c.name ?? '(sin nombre)'} business=${c.business_id}`,
    );
  }

  const customerIds = customers.map((c) => c.id);
  const phones = [...new Set(customers.map((c) => c.phone_number))];

  const conversations = await prisma.conversation.findMany({
    where: { customer_id: { in: customerIds } },
    select: { id: true, status: true, customer_id: true, last_message_at: true },
  });
  const conversationIds = conversations.map((c) => c.id);

  const [msgCount, stateCount, orders, proofs, reservations, drafts, addresses] =
    await Promise.all([
      conversationIds.length
        ? prisma.conversation_message.count({ where: { conversation_id: { in: conversationIds } } })
        : Promise.resolve(0),
      conversationIds.length
        ? prisma.conversation_state.count({ where: { conversation_id: { in: conversationIds } } })
        : Promise.resolve(0),
      prisma.orders.findMany({
        where: {
          OR: [
            { customer_id: { in: customerIds } },
            ...(conversationIds.length
              ? [{ conversation_id: { in: conversationIds } }]
              : []),
          ],
        },
        select: {
          id: true,
          status: true,
          payment_status: true,
          conversation_id: true,
          customer_id: true,
        },
      }),
      prisma.payment_proof.findMany({
        where: {
          OR: [
            { customer_id: { in: customerIds } },
            ...(conversationIds.length
              ? [{ conversation_id: { in: conversationIds } }]
              : []),
          ],
        },
        select: { id: true, status: true, order_id: true, customer_id: true },
      }),
      prisma.reservation.findMany({
        where: {
          OR: [
            { customer_id: { in: customerIds } },
            ...(conversationIds.length
              ? [{ conversation_id: { in: conversationIds } }]
              : []),
          ],
        },
        select: {
          id: true,
          status: true,
          reservation_date: true,
          conversation_id: true,
          customer_id: true,
        },
      }),
      prisma.draft_order.findMany({
        where: {
          OR: [
            { customer_phone: { in: [...phones, ...variants] } },
            { customer_phone: { endsWith: suffix } },
          ],
          ...(businessId ? { business_id: businessId } : {}),
        },
        select: { id: true, status: true, customer_phone: true, total_amount: true },
      }),
      prisma.customer_address.findMany({
        where: { customer_id: { in: customerIds } },
        select: { id: true, is_default: true, is_active: true },
      }),
    ]);

  // Solo borramos pedidos/reservas del customer; si hay FKs de terceros a la
  // conversación, se desvinculan (null) para no borrar data de otros clientes.
  const customerIdSet = new Set(customerIds);
  const ordersToDelete = orders.filter((o) => customerIdSet.has(o.customer_id));
  const ordersToUnlink = orders.filter((o) => !customerIdSet.has(o.customer_id));
  const reservationsToDelete = reservations.filter((r) => customerIdSet.has(r.customer_id));
  const reservationsToUnlink = reservations.filter((r) => !customerIdSet.has(r.customer_id));
  const proofsToDelete = proofs.filter(
    (p) => customerIdSet.has(p.customer_id) || ordersToDelete.some((o) => o.id === p.order_id),
  );

  const orderIds = ordersToDelete.map((o) => o.id);
  const draftIds = drafts.map((d) => d.id);

  const paymentIntents = await prisma.payment_intent.findMany({
    where: {
      OR: [
        ...(draftIds.length ? [{ draft_order_id: { in: draftIds } }] : []),
        ...(orderIds.length ? [{ order_id: { in: orderIds } }] : []),
      ],
    },
    select: { id: true, status: true, draft_order_id: true, order_id: true },
  });

  console.log('\n[wipe] resumen a eliminar:');
  console.log(`  customers          : ${customers.length}`);
  console.log(`  conversations      : ${conversations.length}`, conversations.map((c) => `${c.id.slice(0, 8)}…/${c.status}`));
  console.log(`  messages           : ${msgCount}`);
  console.log(`  conversation_state : ${stateCount}`);
  console.log(`  orders             : ${ordersToDelete.length}`, ordersToDelete.map((o) => `${o.id.slice(0, 8)}…/${o.status}`));
  if (ordersToUnlink.length) {
    console.log(`  orders (unlink FK) : ${ordersToUnlink.length}`);
  }
  console.log(`  payment_proof      : ${proofsToDelete.length}`);
  console.log(`  payment_intent     : ${paymentIntents.length}`);
  console.log(`  reservations       : ${reservationsToDelete.length}`);
  if (reservationsToUnlink.length) {
    console.log(`  reservations unlink: ${reservationsToUnlink.length}`);
  }
  console.log(`  draft_orders       : ${drafts.length}`);
  console.log(`  addresses          : ${addresses.length}`);

  if (!EXECUTE) {
    console.log('\n[wipe] DRY-RUN: no se borró nada. Reejecutá con --execute para confirmar.');
    await prisma.$disconnect();
    return;
  }

  const result = await prisma.$transaction(async (tx) => {
    const deleted: Record<string, number> = {};

    // 1) payment_intent (bloquea draft_order y orders)
    deleted.payment_intent = paymentIntents.length
      ? (
          await tx.payment_intent.deleteMany({
            where: { id: { in: paymentIntents.map((p) => p.id) } },
          })
        ).count
      : 0;

    // 2) payment_proof (bloquea orders / customer / conversation)
    deleted.payment_proof = (
      await tx.payment_proof.deleteMany({
        where: {
          OR: [
            { customer_id: { in: customerIds } },
            ...(orderIds.length ? [{ order_id: { in: orderIds } }] : []),
            ...(conversationIds.length
              ? [{ conversation_id: { in: conversationIds } }]
              : []),
          ],
        },
      })
    ).count;

    // 3) orders del customer (+ cascade order_item)
    deleted.orders = (
      await tx.orders.deleteMany({
        where: { customer_id: { in: customerIds } },
      })
    ).count;

    // 3b) desvincular orders de terceros que apunten a estas conversaciones
    if (conversationIds.length) {
      deleted.orders_unlinked = (
        await tx.orders.updateMany({
          where: { conversation_id: { in: conversationIds } },
          data: { conversation_id: null },
        })
      ).count;
    } else {
      deleted.orders_unlinked = 0;
    }

    // 4) reservations del customer (+ cascade reservation_table)
    deleted.reservations = (
      await tx.reservation.deleteMany({
        where: { customer_id: { in: customerIds } },
      })
    ).count;

    if (conversationIds.length) {
      deleted.reservations_unlinked = (
        await tx.reservation.updateMany({
          where: { conversation_id: { in: conversationIds } },
          data: { conversation_id: null },
        })
      ).count;
    } else {
      deleted.reservations_unlinked = 0;
    }

    // 5) drafts (+ items, sin cascade en schema)
    if (draftIds.length) {
      deleted.draft_order_item = (
        await tx.draft_order_item.deleteMany({
          where: { draft_order_id: { in: draftIds } },
        })
      ).count;
      deleted.draft_order = (
        await tx.draft_order.deleteMany({
          where: { id: { in: draftIds } },
        })
      ).count;
    } else {
      deleted.draft_order_item = 0;
      deleted.draft_order = 0;
    }

    // 6) conversations (+ cascade messages + state)
    deleted.conversations = (
      await tx.conversation.deleteMany({
        where: { customer_id: { in: customerIds } },
      })
    ).count;

    // 7) addresses — null FK en orders de terceros si apuntaran a estas direcciones
    const addressIds = addresses.map((a) => a.id);
    if (addressIds.length) {
      await tx.orders.updateMany({
        where: { customer_address_id: { in: addressIds } },
        data: { customer_address_id: null },
      });
    }
    deleted.addresses = (
      await tx.customer_address.deleteMany({
        where: { customer_id: { in: customerIds } },
      })
    ).count;

    // 8) customer
    deleted.customers = (
      await tx.customer.deleteMany({
        where: { id: { in: customerIds } },
      })
    ).count;

    return deleted;
  });

  console.log('\n[wipe] eliminado:', result);
  console.log('[wipe] listo. El próximo mensaje de ese número arranca como cliente nuevo.');
  await prisma.$disconnect();
}

async function wipeDrafts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: { $transaction: (fn: (tx: any) => Promise<void>) => Promise<void> },
  draftIds: string[],
) {
  if (!draftIds.length) return;
  await prisma.$transaction(async (tx) => {
    await tx.payment_intent.deleteMany({ where: { draft_order_id: { in: draftIds } } });
    await tx.draft_order_item.deleteMany({ where: { draft_order_id: { in: draftIds } } });
    await tx.draft_order.deleteMany({ where: { id: { in: draftIds } } });
  });
}

main().catch(async (err) => {
  console.error('[wipe] error:', err);
  process.exit(1);
});
