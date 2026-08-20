/**
 * Deduplica menu_item de Sabrosón por nombre (trim + lowercase).
 * Por cada grupo deja UN keeper y soft-deletea el resto (`is_available = false`).
 * El bot / búsqueda solo mira disponibles, así que alcanza para pruebas.
 *
 * Uso:
 *   npx tsx scripts/dedupe-sabroson-menu.ts           # dry-run
 *   npx tsx scripts/dedupe-sabroson-menu.ts --execute # aplica
 */
import 'dotenv/config';

const EXECUTE = process.argv.includes('--execute');

type ItemRow = {
  id: string;
  name: string;
  is_available: boolean;
  created_at: Date;
  description: string | null;
  variations: string[];
  menu_category: { name: string };
  menu_item_price: { amount: unknown; currency_code: string }[];
};

function score(it: ItemRow): number {
  const hasPrice = it.menu_item_price.length > 0 ? 100 : 0;
  const avail = it.is_available ? 50 : 0;
  const vars = Math.min(it.variations?.length ?? 0, 10) * 2;
  const desc = it.description?.trim() ? 5 : 0;
  // Más reciente gana el empate (ms → fracción pequeña)
  const recency = it.created_at.getTime() / 1e15;
  return hasPrice + avail + vars + desc + recency;
}

function pickKeeper(group: ItemRow[]): { keeper: ItemRow; losers: ItemRow[] } {
  const ranked = [...group].sort((a, b) => score(b) - score(a));
  return { keeper: ranked[0]!, losers: ranked.slice(1) };
}

function fmtPrice(it: ItemRow): string {
  const p = it.menu_item_price[0];
  return p ? `$${String(p.amount)}` : '$?';
}

async function main() {
  const { prisma } = await import('../src/lib/prisma');

  const businesses = await prisma.business.findMany({
    where: { name: { contains: 'Sabros', mode: 'insensitive' } },
    select: { id: true, name: true, is_active: true },
  });

  if (!businesses.length) {
    console.error('No se encontró negocio con nombre que contenga "Sabros"');
    process.exit(1);
  }

  console.log(`[dedupe] modo=${EXECUTE ? 'EXECUTE' : 'DRY-RUN'}`);
  console.log('[dedupe] businesses:', businesses);

  let totalGroups = 0;
  let totalLosers = 0;
  let totalReenabled = 0;

  for (const b of businesses) {
    const items = (await prisma.menu_item.findMany({
      where: { business_id: b.id },
      select: {
        id: true,
        name: true,
        is_available: true,
        created_at: true,
        description: true,
        variations: true,
        menu_category: { select: { name: true } },
        menu_item_price: {
          where: { is_active: true },
          select: { amount: true, currency_code: true },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
    })) as ItemRow[];

    const byName = new Map<string, ItemRow[]>();
    for (const it of items) {
      const key = it.name.trim().toLowerCase();
      const list = byName.get(key) ?? [];
      list.push(it);
      byName.set(key, list);
    }

    const dups = [...byName.entries()].filter(([, g]) => g.length > 1);
    console.log(`\n[${b.name}] items=${items.length} nombres_duplicados=${dups.length}`);

    const loserIds: string[] = [];
    const reenableIds: string[] = [];

    for (const [name, group] of dups) {
      const { keeper, losers } = pickKeeper(group);
      totalGroups += 1;
      totalLosers += losers.length;

      const needReenable = !keeper.is_available && keeper.menu_item_price.length > 0;
      if (needReenable) {
        reenableIds.push(keeper.id);
        totalReenabled += 1;
      }

      console.log(`--- ${name} (${group.length})`);
      console.log(
        `  KEEP ${keeper.id.slice(0, 8)} avail=${keeper.is_available}${needReenable ? '→true' : ''} cat=${keeper.menu_category.name} ${fmtPrice(keeper)} vars=${JSON.stringify(keeper.variations)} score=${score(keeper).toFixed(2)}`,
      );
      for (const l of losers) {
        loserIds.push(l.id);
        console.log(
          `  DROP ${l.id.slice(0, 8)} avail=${l.is_available}→false cat=${l.menu_category.name} ${fmtPrice(l)} vars=${JSON.stringify(l.variations)} score=${score(l).toFixed(2)}`,
        );
      }
    }

    if (!EXECUTE) continue;

    if (loserIds.length) {
      const res = await prisma.menu_item.updateMany({
        where: { business_id: b.id, id: { in: loserIds } },
        data: { is_available: false },
      });
      console.log(`[dedupe] soft-deleted ${res.count} losers`);
    }
    if (reenableIds.length) {
      const res = await prisma.menu_item.updateMany({
        where: { business_id: b.id, id: { in: reenableIds } },
        data: { is_available: true },
      });
      console.log(`[dedupe] re-enabled ${res.count} keepers`);
    }
  }

  console.log(
    `\n[dedupe] resumen: grupos=${totalGroups} losers=${totalLosers} keepers_reenablados=${totalReenabled}`,
  );
  if (!EXECUTE) {
    console.log('[dedupe] dry-run OK. Para aplicar: npx tsx scripts/dedupe-sabroson-menu.ts --execute');
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
