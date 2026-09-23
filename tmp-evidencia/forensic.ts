import { prisma } from '../src/lib/prisma';

async function main() {
  const productId = '742df439-a245-4414-8f30-289ab8097cac';
  const phone = '5493413867990';

  // 1. ¿Existe la línea en ALGÚN draft (cualquier estado)?
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT doi.id, doi.draft_order_id, doi.quantity, doi.variation, d.status, d.created_at
    FROM draft_order_item doi
    JOIN draft_order d ON d.id = doi.draft_order_id
    WHERE doi.product_id = ${productId}::uuid
    ORDER BY d.created_at DESC
    LIMIT 10
  `;
  console.log('lineas del producto en cualquier draft:', rows.length);
  for (const r of rows) console.log(JSON.stringify(r));

  // 2. Triggers sobre draft_order_item
  const triggers = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT tgname, tgrelid::regclass::text AS tabla, tgenabled
    FROM pg_trigger
    WHERE tgrelid = 'draft_order_item'::regclass AND NOT tgisinternal
  `;
  console.log('triggers en draft_order_item:', JSON.stringify(triggers));

  // 3. Drafts del teléfono creados/modificados en la última hora
  const recent = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    SELECT id, status, created_at, updated_at, total_amount
    FROM draft_order
    WHERE customer_phone = ${phone}
      AND updated_at > now() - interval '2 hours'
    ORDER BY updated_at DESC
  `;
  console.log('drafts recientes (2h):');
  for (const r of recent) console.log(JSON.stringify(r));

  await prisma.$disconnect();
}
main();
