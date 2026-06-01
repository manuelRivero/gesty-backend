/**
 * Genera un `reservation_slot` por cada turno en `business_hours`:
 * empieza en la hora de apertura y dura 1 hora (un solo slot por turno).
 *
 * Uso:
 *   npx ts-node -r dotenv/config scripts/reservation/seed-reservation-slots.ts \
 *     --business <UUID> [--force] [--duration-minutes 60]
 *
 *   - --business           UUID del negocio (requerido)
 *   - --force              Borra slots existentes del negocio y los regenera
 *   - --duration-minutes   Duración del slot (default 60)
 */

import { prisma } from '../../src/lib/prisma';

const DEFAULT_BUSINESS_ID = 'bc268eb1-a6a9-4278-bfea-904a5eb0072d';

interface CliArgs {
  businessId: string;
  force: boolean;
  durationMinutes: number;
}

function parseArgs(argv: string[]): CliArgs {
  let businessId = DEFAULT_BUSINESS_ID;
  let force = false;
  let durationMinutes = 60;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--business' || arg === '--businessId') {
      businessId = argv[++i] ?? businessId;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--duration-minutes') {
      const parsed = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) durationMinutes = parsed;
    }
  }

  return { businessId, force, durationMinutes };
}

function timeToMinutes(value: string): number {
  const [hh, mm] = value.split(':').map((part) => Number(part));
  return (hh || 0) * 60 + (mm || 0);
}

function minutesToTime(minutes: number): string {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/**
 * Un slot por turno: inicio = apertura, fin = apertura + duración.
 * Retorna null si el turno no alcanza a cubrir esa duración antes del cierre.
 */
export function buildOpeningSlotFromTurn(
  opensAt: string,
  closesAt: string,
  durationMinutes: number
): { start_time: string; end_time: string } | null {
  const open = timeToMinutes(opensAt);
  const close = timeToMinutes(closesAt);
  if (close <= open || open + durationMinutes > close) {
    return null;
  }
  return {
    start_time: minutesToTime(open),
    end_time: minutesToTime(open + durationMinutes),
  };
}

function timeToPrismaDate(hhmm: string): Date {
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(1970, 0, 1, hh || 0, mm || 0, 0));
}

async function main() {
  const { businessId, force, durationMinutes } = parseArgs(process.argv.slice(2));

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, name: true },
  });
  if (!business) {
    throw new Error(`Negocio no encontrado: ${businessId}`);
  }

  const hours = await prisma.business_hours.findMany({
    where: { business_id: businessId },
    orderBy: [{ day_of_week: 'asc' }, { opens_at: 'asc' }],
  });

  if (!hours.length) {
    throw new Error(
      `Sin business_hours para ${businessId}. Configurá horarios antes del seed.`
    );
  }

  const existing = await prisma.reservation_slot.count({
    where: { business_id: businessId },
  });

  if (existing > 0 && !force) {
    console.log(
      `[seed] Ya hay ${existing} slot(s) para "${business.name}". Usá --force para regenerar.`
    );
    await prisma.$disconnect();
    return;
  }

  if (force && existing > 0) {
    const deleted = await prisma.reservation_slot.deleteMany({
      where: { business_id: businessId },
    });
    console.log(`[seed] Eliminados ${deleted.count} slot(s) previos (--force).`);
  }

  const rows: Array<{
    business_id: string;
    day_of_week: number;
    start_time: Date;
    end_time: Date;
    is_active: boolean;
  }> = [];

  for (const row of hours) {
    if (row.is_closed) continue;

    const slot = buildOpeningSlotFromTurn(
      row.opens_at,
      row.closes_at,
      durationMinutes
    );

    if (!slot) {
      console.warn(
        `[seed] Turno omitido (dow=${row.day_of_week} ${row.opens_at}-${row.closes_at}): no cabe slot de ${durationMinutes} min`
      );
      continue;
    }

    rows.push({
      business_id: businessId,
      day_of_week: row.day_of_week,
      start_time: timeToPrismaDate(slot.start_time),
      end_time: timeToPrismaDate(slot.end_time),
      is_active: true,
    });
  }

  if (!rows.length) {
    throw new Error('No se generó ningún slot (¿todos los días cerrados?).');
  }

  const created = await prisma.reservation_slot.createMany({ data: rows });

  const byDay = new Map<number, number>();
  for (const r of rows) {
    byDay.set(r.day_of_week, (byDay.get(r.day_of_week) ?? 0) + 1);
  }

  console.log(`[seed] Negocio: ${business.name} (${businessId})`);
  console.log(`[seed] Duración por slot: ${durationMinutes} min`);
  console.log(`[seed] Slots creados: ${created.count}`);
  console.log('[seed] Por day_of_week (0=dom … 6=sáb):', Object.fromEntries(byDay));

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
