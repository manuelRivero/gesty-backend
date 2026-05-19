/**
 * Carga masiva inicial de embeddings para `menu_item` de UN business.
 *
 * Uso (manual / on-demand, NO se ejecuta en CI ni en boot):
 *
 *   ts-node -r dotenv/config scripts/embedding/create-menu_item-vector.ts \
 *     --business <UUID> [--force] [--concurrency 3]
 *
 *   - --business     UUID del business cuyos productos se van a embeber (requerido).
 *   - --force        Reprocesa también los items que ya tienen `embedding`.
 *                    Por defecto solo se embeben los que tienen `embedding IS NULL`.
 *   - --concurrency  Cantidad de llamadas en paralelo a OpenAI (default 3).
 *
 * Para refresh por producto desde el admin se usa el servicio
 * `src/services/ai/menuItemEmbedding.service.ts`, no este script.
 */

import { prisma } from '../../src/lib/prisma';
import { refreshMenuItemEmbedding } from '../../src/services/ai/menuItemEmbedding.service';

interface CliArgs {
  businessId: string;
  force: boolean;
  concurrency: number;
}

function parseArgs(argv: string[]): CliArgs {
  let businessId: string | null = null;
  let force = false;
  let concurrency = 3;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--business' || arg === '--businessId') {
      businessId = argv[++i] ?? null;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--concurrency') {
      const raw = argv[++i];
      const parsed = Number.parseInt(raw ?? '', 10);
      if (Number.isFinite(parsed) && parsed > 0) concurrency = parsed;
    }
  }

  if (!businessId) {
    throw new Error(
      'Falta --business <UUID>. Uso: ts-node scripts/embedding/create-menu_item-vector.ts --business <id> [--force] [--concurrency N]'
    );
  }

  return { businessId, force, concurrency: Math.max(1, Math.min(concurrency, 10)) };
}

/** Reintentos exponenciales simples para errores transitorios de OpenAI (429/5xx). */
async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 500
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1) break;
      const delay = baseDelayMs * Math.pow(2, i);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** Pool manual de workers (evita sumar dependencias por una sola corrida). */
async function withConcurrency<T>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) return;
        await fn(items[idx], idx);
      }
    }
  );
  await Promise.all(workers);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const business = await prisma.business.findUnique({
    where: { id: args.businessId },
    select: { id: true, name: true }
  });
  if (!business) {
    throw new Error(`Business no encontrado: ${args.businessId}`);
  }

  const ids = args.force
    ? await prisma.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM menu_item
        WHERE business_id = ${args.businessId}::uuid
      `
    : await prisma.$queryRaw<{ id: string }[]>`
        SELECT id
        FROM menu_item
        WHERE business_id = ${args.businessId}::uuid
          AND embedding IS NULL
      `;

  if (ids.length === 0) {
    console.log(
      `[embedding-seed] Nada para procesar (business=${business.name}, force=${args.force}).`
    );
    return;
  }

  console.log(
    `[embedding-seed] business=${business.name} items=${ids.length} concurrency=${args.concurrency} force=${args.force}`
  );

  let ok = 0;
  let failed = 0;
  await withConcurrency(ids, args.concurrency, async ({ id }, idx) => {
    try {
      const res = await withRetry(() => refreshMenuItemEmbedding(id));
      if (res.updated) ok++;
      else failed++;
      if ((idx + 1) % 10 === 0 || idx === ids.length - 1) {
        console.log(
          `[embedding-seed] progreso ${idx + 1}/${ids.length} (ok=${ok} fail=${failed})`
        );
      }
    } catch (err) {
      failed++;
      console.error(`[embedding-seed] fallo item ${id}:`, err);
    }
  });

  console.log(`[embedding-seed] Listo. ok=${ok} fail=${failed} total=${ids.length}`);
}

main()
  .catch((err) => {
    console.error('[embedding-seed] error fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
