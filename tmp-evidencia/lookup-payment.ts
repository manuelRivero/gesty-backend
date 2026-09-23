import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const draftId = '8afdee3f-e9c5-497b-b5f1-ed7bded61045';
const businessId = 'e89dfb88-a409-4818-a01e-37d7d5ba2e11';
const pref = '2415045762-15c126ef-0d4f-419b-bb21-7ec79f50e43d';
const pay = '179570622499';

async function main() {
  const intents = await prisma.payment_intent.findMany({
    where: {
      OR: [
        { draft_order_id: draftId },
        { order_id: draftId },
        { preference_id: pref },
        { external_id: pay },
        { business_id: businessId },
      ],
    },
    orderBy: { created_at: 'desc' },
    take: 8,
    select: {
      id: true,
      business_id: true,
      draft_order_id: true,
      order_id: true,
      status: true,
      preference_id: true,
      external_id: true,
      amount: true,
      created_at: true,
      updated_at: true,
    },
  });
  const draft = await prisma.draft_order.findUnique({
    where: { id: draftId },
    select: {
      id: true,
      status: true,
      customer_phone: true,
      payment_method: true,
      business_id: true,
      updated_at: true,
    },
  });
  const biz = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, name: true },
  });
  console.log(JSON.stringify({ biz, draft, intents }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
