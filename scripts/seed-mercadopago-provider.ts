/**
 * Seed — Credenciales de Mercado Pago por business
 * ===================================================
 *
 * Crea o actualiza el registro en `business_payment_provider` para un business
 * específico con las credenciales de Mercado Pago (Checkout Pro).
 *
 * El `access_token` se almacena cifrado con AES-256-GCM usando la clave maestra
 * `PAYMENT_PROVIDER_ENCRYPTION_KEY` del entorno. Nunca se guarda en texto plano.
 *
 * USO
 * ---
 *   npx ts-node -r dotenv/config scripts/seed-mercadopago-provider.ts \
 *     --business-id  <uuid>          (requerido)
 *     --access-token <APP_USR-...>   (requerido)  token de producción o sandbox
 *     [--public-key  <APP_USR-...>]  (opcional)   clave pública MP
 *     [--webhook-secret <secret>]    (opcional)   secreto para validar firma del webhook
 *     [--sandbox]                    (opcional)   marcar como credenciales sandbox (TEST-...)
 *     [--deactivate]                 (opcional)   desactivar el provider en lugar de activarlo
 *
 * EJEMPLOS
 * --------
 *   # Registrar credenciales de producción:
 *   npx ts-node -r dotenv/config scripts/seed-mercadopago-provider.ts \
 *     --business-id 550e8400-e29b-41d4-a716-446655440000 \
 *     --access-token APP_USR-1234567890-XXXXXXXX-YYYYYYYY \
 *     --public-key APP_USR-ZZZZZZZZ-XXXXXXXX \
 *     --webhook-secret mi_webhook_secret_generado_en_mp
 *
 *   # Registrar credenciales sandbox (testing):
 *   npx ts-node -r dotenv/config scripts/seed-mercadopago-provider.ts \
 *     --business-id 550e8400-e29b-41d4-a716-446655440000 \
 *     --access-token TEST-1234567890-XXXXXXXX-YYYYYYYY \
 *     --public-key TEST-ZZZZZZZZ-XXXXXXXX \
 *     --sandbox
 *
 *   # Desactivar el provider de un business:
 *   npx ts-node -r dotenv/config scripts/seed-mercadopago-provider.ts \
 *     --business-id 550e8400-e29b-41d4-a716-446655440000 \
 *     --access-token placeholder \
 *     --deactivate
 *
 * DÓNDE OBTENER LAS CREDENCIALES
 * --------------------------------
 *   1. Ingresá a https://www.mercadopago.com.ar/developers/panel
 *   2. Seleccioná tu aplicación (o creá una nueva).
 *   3. En "Credenciales de producción" / "Credenciales de prueba" encontrás:
 *      - Access Token  → --access-token
 *      - Public Key    → --public-key
 *   4. Para el webhook secret: en el panel de MP, sección "Webhooks" → "Firma secreta"
 *      → --webhook-secret
 *
 * NOTAS DE SEGURIDAD
 * ------------------
 *   - La variable PAYMENT_PROVIDER_ENCRYPTION_KEY debe estar en .env antes de correr.
 *     Generarla con: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *   - No commitear el .env ni los tokens a git.
 *   - En producción usar variables de entorno del servidor, no .env.
 */

import { prisma } from '../src/lib/prisma';
import { encryptToken } from '../src/services/payment/crypto';

// ---------------------------------------------------------------------------
// Parseo de argumentos
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i].trim();
    if (arg.startsWith('--')) {
      const key = arg.slice(2).trim();
      const next = argv[i + 1]?.trim();
      if (!next || next.startsWith('--')) {
        result[key] = true;
      } else {
        result[key] = next;
        i++;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const businessId = args['business-id'] as string | undefined;
  const rawAccessToken = args['access-token'] as string | undefined;
  const publicKey = args['public-key'] as string | undefined;
  const webhookSecret = args['webhook-secret'] as string | undefined;
  const isSandbox = Boolean(args['sandbox']);
  const deactivate = Boolean(args['deactivate']);

  // Validaciones
  if (!businessId || !rawAccessToken) {
    console.error('\n❌  Faltan parámetros requeridos.\n');
    console.error('  Uso: npx ts-node -r dotenv/config scripts/seed-mercadopago-provider.ts \\');
    console.error('         --business-id <uuid> --access-token <token>\n');
    process.exit(1);
  }

  if (!process.env.PAYMENT_PROVIDER_ENCRYPTION_KEY) {
    console.error('\n❌  PAYMENT_PROVIDER_ENCRYPTION_KEY no está definida en el entorno.');
    console.error('   Generala con:');
    console.error("   node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"\n");
    process.exit(1);
  }

  // Verificar que el business existe
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { id: true, name: true, currency_code: true },
  });

  if (!business) {
    console.error(`\n❌  Business con id "${businessId}" no encontrado.\n`);
    process.exit(1);
  }

  console.log('\n🏪  Business encontrado:');
  console.log(`   id:       ${business.id}`);
  console.log(`   nombre:   ${business.name}`);
  console.log(`   moneda:   ${business.currency_code ?? 'no configurada'}`);

  // Cifrar el access_token
  const accessTokenEncrypted = deactivate ? encryptToken('deactivated') : encryptToken(rawAccessToken);

  const tokenPreview = rawAccessToken.length > 12
    ? `${rawAccessToken.slice(0, 8)}...${rawAccessToken.slice(-4)}`
    : '****';

  // Upsert en business_payment_provider
  const existing = await prisma.business_payment_provider.findFirst({
    where: { business_id: businessId, provider: 'mercado_pago' },
  });

  const isActive = !deactivate;

  if (existing) {
    await prisma.business_payment_provider.update({
      where: { id: existing.id },
      data: {
        access_token_encrypted: accessTokenEncrypted,
        public_key: publicKey ?? existing.public_key,
        webhook_secret: webhookSecret ?? existing.webhook_secret,
        is_sandbox: isSandbox,
        is_active: isActive,
        updated_at: new Date(),
      },
    });
    console.log('\n✅  Provider actualizado exitosamente.');
    console.log(`   id:             ${existing.id}`);
  } else {
    const created = await prisma.business_payment_provider.create({
      data: {
        business_id: businessId,
        provider: 'mercado_pago',
        access_token_encrypted: accessTokenEncrypted,
        public_key: publicKey ?? null,
        webhook_secret: webhookSecret ?? null,
        is_sandbox: isSandbox,
        is_active: isActive,
      },
    });
    console.log('\n✅  Provider creado exitosamente.');
    console.log(`   id:             ${created.id}`);
  }

  console.log(`   provider:       mercado_pago`);
  console.log(`   access_token:   ${tokenPreview} (cifrado en BD)`);
  console.log(`   public_key:     ${publicKey ? `${publicKey.slice(0, 8)}...` : '(no configurada)'}`);
  console.log(`   webhook_secret: ${webhookSecret ? '(configurado)' : '(no configurado)'}`);
  console.log(`   sandbox:        ${isSandbox ? 'SÍ ⚠️  (solo para testing)' : 'NO (producción)'}`);
  console.log(`   activo:         ${isActive ? 'SÍ' : 'NO'}`);

  if (isSandbox) {
    console.log('\n⚠️   MODO SANDBOX activo — los pagos son simulados y no generan cobros reales.');
    console.log('   Para probar: https://www.mercadopago.com.ar/developers/es/docs/your-integrations/test/test-cards');
  }

  if (!webhookSecret) {
    console.log('\n💡  Sin webhook_secret: la firma del webhook no se validará.');
    console.log('   Para mayor seguridad, configuralo en el panel de MP y volvé a correr el script con --webhook-secret.');
  }

  console.log('');
}

main()
  .catch((err) => {
    console.error('\n❌  Error inesperado:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
