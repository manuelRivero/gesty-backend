import 'dotenv/config';

async function main() {
  const { prisma } = await import('../src/lib/prisma');
  const businesses = await prisma.business.findMany({
    where: { name: { contains: 'Sabros', mode: 'insensitive' } },
    select: { id: true, name: true, is_active: true },
  });
  console.log('businesses:', businesses);
  if (!businesses.length) {
    const all = await prisma.business.findMany({ select: { id: true, name: true }, take: 40 });
    console.log('sample businesses:', all);
  }
  for (const b of businesses) {
    const items = await prisma.menu_item.findMany({
      where: { business_id: b.id },
      select: {
        id: true,
        name: true,
        is_available: true,
        category_id: true,
        variations: true,
        menu_category: { select: { name: true } },
        menu_item_price: {
          where: { is_active: true },
          select: { amount: true, currency_code: true },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
    });
    console.log(`\n[${b.name}] total items: ${items.length}`);
    const byName = new Map<string, typeof items>();
    for (const it of items) {
      const key = it.name.trim().toLowerCase();
      const list = byName.get(key) ?? [];
      list.push(it);
      byName.set(key, list);
    }
    const dups = [...byName.entries()].filter(([, v]) => v.length > 1);
    console.log(`nombres duplicados: ${dups.length}`);
    for (const [name, group] of dups) {
      console.log('---', name, `(${group.length})`);
      for (const g of group) {
        const price = g.menu_item_price[0]?.amount ?? '?';
        console.log(
          '  ',
          g.id.slice(0, 8),
          '| avail=' + g.is_available,
          '| cat=' + g.menu_category.name,
          '| $' + price,
          '| vars=' + JSON.stringify(g.variations),
        );
      }
    }
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
