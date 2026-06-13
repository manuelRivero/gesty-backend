/**
 * Seed — Configuración de comportamiento del bot en horario cerrado
 * =================================================================
 *
 * Actualiza (o crea) los campos `operate_when_closed` y `orders_when_closed`
 * en `business_config` para un business específico.
 *
 * operate_when_closed
 *   false (default) → el bot bloquea toda interacción cuando el negocio está cerrado
 *   true            → el bot sigue operando fuera del horario de atención
 *
 * orders_when_closed  (solo relevante si operate_when_closed=true)
 *   false (default) → el bot opera, pero oculta las opciones de "Agregar al carrito"
 *   true            → el bot permite ordenar; avisa que el pedido se atiende en el
 *                     próximo turno y exige confirmación explícita del usuario
 *
 * USO
 * ---
 *   npx ts-node -r dotenv/config scripts/seed-closed-hours-config.ts \
 *     --business-id <uuid>        (requerido)
 *     --operate-when-closed <bool> (requerido: true | false)
 *     --orders-when-closed <bool>  (requerido: true | false)
 *
 * EJEMPLOS
 * --------
 *   # Bot bloqueado cuando cierra (comportamiento por defecto):
 *   npx ts-node -r dotenv/config scripts/seed-closed-hours-config.ts \
 *     --business-id 550e8400-e29b-41d4-a716-446655440000 \
 *     --operate-when-closed false \
 *     --orders-when-closed false
 *
 *   # Bot opera cuando cierra pero no acepta pedidos:
 *   npx ts-node -r dotenv/config scripts/seed-closed-hours-config.ts \
 *     --business-id 550e8400-e29b-41d4-a716-446655440000 \
 *     --operate-when-closed true \
 *     --orders-when-closed false
 *
 *   # Bot opera y acepta pedidos con confirmación y aviso de próximo turno:
 *   npx ts-node -r dotenv/config scripts/seed-closed-hours-config.ts \
 *     --business-id 550e8400-e29b-41d4-a716-446655440000 \
 *     --operate-when-closed true \
 *     --orders-when-closed true
 */

import { prisma } from '../src/lib/prisma';
import { upsertBusinessConfig } from '../src/services/businessConfig.service';

// ---------------------------------------------------------------------------
// Parseo de argumentos
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i].trim();
    if (arg.startsWith('--')) {
      const key = arg.slice(2).trim();
      const next = argv[i + 1]?.trim();
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      }
    }
  }
  return result;
}

function parseBool(value: string | undefined, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  console.error(`\n❌  Valor inválido para --${name}: "${value ?? '(ausente)'}". Debe ser true o false.\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const businessId = args['business-id'];
  const rawOperate = args['operate-when-closed'];
  const rawOrders = args['orders-when-closed'];

  if (!businessId || rawOperate === undefined || rawOrders === undefined) {
    console.error('\n❌  Faltan parámetros requeridos.\n');
    console.error('  Uso:');
    console.error('    npx ts-node -r dotenv/config scripts/seed-closed-hours-config.ts \\');
    console.error('      --business-id <uuid> \\');
    console.error('      --operate-when-closed <true|false> \\');
    console.error('      --orders-when-closed  <true|false>\n');
    process.exit(1);
  }

  const operateWhenClosed = parseBool(rawOperate, 'operate-when-closed');
  const ordersWhenClosed = parseBool(rawOrders, 'orders-when-closed');

  if (!operateWhenClosed && ordersWhenClosed) {
    console.warn('\n⚠️   orders-when-closed=true no tiene efecto cuando operate-when-closed=false.');
    console.warn('   El bot bloqueará toda interacción de todas formas.\n');
  }

  // Verificar que el business existe
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, name: true },
  });

  if (!business) {
    console.error(`\n❌  Business con id "${businessId}" no encontrado.\n`);
    process.exit(1);
  }

  console.log('\n🏪  Business encontrado:');
  console.log(`   id:     ${business.id}`);
  console.log(`   nombre: ${business.name}`);

  const updated = await upsertBusinessConfig(businessId, {
    operate_when_closed: operateWhenClosed,
    orders_when_closed: ordersWhenClosed,
  });

  console.log('\n✅  Configuración actualizada:');
  console.log(`   operate_when_closed: ${updated.operate_when_closed}`);
  console.log(`   orders_when_closed:  ${updated.orders_when_closed}`);

  console.log('\n📋  Comportamiento resultante:');
  if (!operateWhenClosed) {
    console.log('   🔒 Bot bloqueado fuera del horario → envía aviso de cierre y no responde.');
  } else if (!ordersWhenClosed) {
    console.log('   🛑 Bot opera pero SIN pedidos → oculta las opciones "Agregar al carrito".');
  } else {
    console.log('   ✅ Bot opera CON pedidos → pide confirmación y avisa el próximo horario de apertura.');
  }

  console.log('');
}

main()
  .catch((err) => {
    console.error('\n❌  Error inesperado:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
