/**
 * Auditoría de datos para flujo de reservas por businessId.
 * Uso: npx ts-node -r dotenv/config scripts/audit-reservation-business.ts <businessId>
 */
import { prisma } from '../src/lib/prisma';

const BUSINESS_ID = process.argv[2] ?? 'bc268eb1-a6a9-4278-bfea-904a5eb0072d';

async function main() {
  const id = BUSINESS_ID;

  console.log('\n=== AUDITORÍA RESERVAS ===');
  console.log('business_id:', id);
  console.log('fecha auditoría:', new Date().toISOString());
  console.log('día semana JS (0=dom):', new Date().getDay());

  const business = await prisma.business.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      is_active: true,
      timezone: true,
      whatsapp_phone_id: true,
      whatsapp_access_token: true,
      openai_active: true,
      ai_blocked: true,
      billing_mode: true,
    },
  });

  if (!business) {
    console.log('\n❌ business NO EXISTE');
    await prisma.$disconnect();
    return;
  }
  console.log('\n--- business ---');
  console.log(JSON.stringify(business, null, 2));

  const configRows = await prisma.$queryRaw<
    Array<Record<string, unknown>>
  >`
    SELECT * FROM business_config WHERE business_id = ${id}::uuid
  `;
  console.log('\n--- business_config ---');
  console.log(
    configRows.length
      ? JSON.stringify(configRows[0], null, 2)
      : '⚠️ SIN FILA (se usan defaults: reservations_enabled=true)'
  );

  const resConfig = await prisma.reservation_config.findUnique({
    where: { business_id: id },
  });
  console.log('\n--- reservation_config ---');
  console.log(resConfig ? JSON.stringify(resConfig, null, 2) : '⚠️ SIN FILA');

  const subscription = await prisma.subscription.findFirst({
    where: { business_id: id },
    select: {
      id: true,
      status: true,
      is_trial: true,
      trial_end: true,
      current_period_end: true,
      cancel_at_period_end: true,
    },
  });
  console.log('\n--- subscription ---');
  console.log(
    subscription ? JSON.stringify(subscription, null, 2) : '⚠️ SIN SUSCRIPCIÓN'
  );

  const hours = await prisma.business_hours.findMany({
    where: { business_id: id },
    orderBy: { day_of_week: 'asc' },
  });
  console.log('\n--- business_hours ---');
  console.log(`count: ${hours.length}`);
  if (hours.length) console.log(JSON.stringify(hours, null, 2));

  const jsDay = new Date().getDay();
  const altDay = jsDay === 0 ? 7 : jsDay;
  const slots = await prisma.$queryRaw<
    Array<{
      id: string;
      day_of_week: number;
      start_time: Date;
      end_time: Date;
      is_active: boolean | null;
      capacity_limit: number | null;
    }>
  >`
    SELECT id, day_of_week, start_time, end_time, is_active, capacity_limit
    FROM reservation_slot
    WHERE business_id = ${id}::uuid
    ORDER BY day_of_week, start_time
  `;
  const slotsToday = slots.filter(
    (s) => s.day_of_week === jsDay || s.day_of_week === altDay
  );
  console.log('\n--- reservation_slot (todos) ---');
  console.log(`total: ${slots.length}`);
  console.log(`hoy (dow ${jsDay} o ${altDay}): ${slotsToday.length}`);
  if (slots.length) {
    const byDay = new Map<number, number>();
    for (const s of slots) {
      byDay.set(s.day_of_week, (byDay.get(s.day_of_week) ?? 0) + 1);
    }
    console.log('por day_of_week:', Object.fromEntries(byDay));
    if (slotsToday.length) {
      console.log('slots hoy:', JSON.stringify(slotsToday, null, 2));
    } else {
      console.log('⚠️ SIN SLOTS para el día de hoy');
    }
  } else {
    console.log('❌ SIN SLOTS — el agente no puede ofrecer horarios');
  }

  const environments = await prisma.environment.findMany({
    where: { business_id: id },
    orderBy: { name: 'asc' },
  });
  console.log('\n--- environment ---');
  console.log(`total: ${environments.length}, activos: ${environments.filter((e) => e.is_active !== false).length}`);
  if (environments.length) console.log(JSON.stringify(environments, null, 2));

  const tables = await prisma.table.findMany({
    where: { business_id: id },
    include: { environment: { select: { id: true, name: true, is_active: true } } },
    orderBy: [{ environment_id: 'asc' }, { capacity: 'asc' }],
  });
  console.log('\n--- table ---');
  console.log(`total: ${tables.length}, activas: ${tables.filter((t) => t.is_active !== false).length}`);
  if (tables.length) {
    const orphanEnv = tables.filter(
      (t) => !environments.some((e) => e.id === t.environment_id)
    );
    if (orphanEnv.length) {
      console.log('❌ mesas con environment_id huérfano:', orphanEnv.map((t) => t.id));
    }
    const inactiveEnvTables = tables.filter(
      (t) => t.environment?.is_active === false
    );
    if (inactiveEnvTables.length) {
      console.log(
        '⚠️ mesas en ambiente inactivo:',
        inactiveEnvTables.map((t) => ({ id: t.id, env: t.environment?.name }))
      );
    }
    console.log(
      'capacidades:',
      tables.map((t) => ({
        id: t.id,
        name: t.name,
        cap: t.capacity,
        active: t.is_active,
        env: t.environment?.name,
      }))
    );
  } else {
    console.log('❌ SIN MESAS — confirmación fallará con "Sin disponibilidad"');
  }

  const blocks = await prisma.reservation_block.findMany({
    where: { business_id: id },
    take: 10,
    orderBy: { date: 'desc' },
  });
  console.log('\n--- reservation_block (últimos 10) ---');
  console.log(`count (muestra): ${blocks.length}`);

  const reservations = await prisma.reservation.findMany({
    where: { business_id: id },
    take: 5,
    orderBy: { created_at: 'desc' },
    include: { reservation_table: { include: { table: true } } },
  });
  console.log('\n--- reservation (últimas 5) ---');
  console.log(`muestra: ${reservations.length}`);

  // Integridad FK
  console.log('\n--- integridad relaciones ---');
  const badTables = await prisma.$queryRaw<
    Array<{ id: string; environment_id: string }>
  >`
    SELECT t.id, t.environment_id
    FROM "table" t
    LEFT JOIN environment e ON e.id = t.environment_id
    WHERE t.business_id = ${id}::uuid AND e.id IS NULL
  `;
  if (badTables.length) {
    console.log('❌ mesas sin environment válido:', badTables);
  } else {
    console.log('✓ todas las mesas tienen environment FK válido');
  }

  const badEnv = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT e.id FROM environment e
    LEFT JOIN business b ON b.id = e.business_id
    WHERE e.business_id = ${id}::uuid AND b.id IS NULL
  `;
  if (badEnv.length) console.log('❌ environments huérfanos:', badEnv);
  else console.log('✓ environments → business OK');

  const badSlots = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT s.id FROM reservation_slot s
    LEFT JOIN business b ON b.id = s.business_id
    WHERE s.business_id = ${id}::uuid AND b.id IS NULL
  `;
  if (badSlots.length) console.log('❌ slots huérfanos:', badSlots);
  else console.log('✓ reservation_slot → business OK');

  // Checklist requisitos agente
  console.log('\n=== CHECKLIST AGENTE RESERVA ===');
  const cfg = configRows[0] as { reservations_enabled?: boolean } | undefined;
  const reservationsEnabled = cfg?.reservations_enabled ?? true;
  const checks: Array<{ ok: boolean; msg: string }> = [
    { ok: !!business, msg: 'Negocio existe' },
    { ok: business.is_active !== false, msg: 'Negocio activo' },
    { ok: !!business.timezone?.trim(), msg: 'Timezone configurado' },
    {
      ok: reservationsEnabled,
      msg: 'reservations_enabled en business_config',
    },
    { ok: slots.length > 0, msg: 'Al menos un reservation_slot' },
    { ok: slotsToday.length > 0, msg: 'Slots para el día actual' },
    { ok: tables.filter((t) => t.is_active !== false).length > 0, msg: 'Al menos una mesa activa' },
    {
      ok: !!business.whatsapp_phone_id && !!business.whatsapp_access_token,
      msg: 'WhatsApp configurado (phone_id + token)',
    },
    { ok: badTables.length === 0, msg: 'FK mesa→environment' },
  ];
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.msg}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
