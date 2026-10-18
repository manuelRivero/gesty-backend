import { Pool, type PoolClient } from "pg";
import crypto from "crypto";
import { env } from "../../config/env";

/**
 * Coordinación distribuida de mutaciones de ciclo de vida de suscripción
 * (cancelar, reactivar, cambiar de plan) y de los webhooks que compiten con
 * ellas. Reemplaza el `pg_advisory_xact_lock` que usaban por separado
 * `stripeCheckout.service.ts` y `subscriptionChangePlan.service.ts`: ese
 * lock se liberaba al cerrar la transacción corta de lectura, mucho antes
 * de la llamada de red a Stripe — no serializaba la operación completa.
 *
 * Esta es la ÚNICA implementación del lock. Todo camino que decide sobre el
 * ciclo de vida de una suscripción (`cancelOwnerSubscription`,
 * `reactivateSubscription`, `changeSubscriptionPlan`/`applyUpgrade`/
 * `scheduleDowngrade`, y el handler de webhooks de `customer.subscription.*`)
 * debe pasar por `withBillingLock` con el mismo `namespace`
 * (`SUBSCRIPTION_LIFECYCLE`, exportado más abajo) — nunca con uno propio.
 * Si en el futuro se agrega un camino nuevo que mute `subscription` para un
 * negocio, debe adquirir este mismo lock antes de leer el estado que usa
 * para decidir.
 *
 * Pool dedicado, separado del pool de Prisma (`src/lib/prisma.ts`): la
 * conexión que sostiene el advisory lock de sesión debe mantenerse viva
 * (fuera de cualquier transacción) durante toda la llamada a Stripe, y no
 * queremos que eso compita por conexiones con las queries de negocio ni que
 * el adapter de Prisma reutilice esa misma conexión para otra cosa mientras
 * el lock está tomado.
 */

const lockPool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

lockPool.on("error", (err) => {
  // Conexiones idle del pool pueden caerse (ej. el servidor de Postgres
  // las cierra) sin que haya ningún checkout en curso. Sin este handler,
  // ese evento no manejado tira abajo el proceso (comportamiento default
  // de `pg.Pool`/EventEmitter ante un 'error' sin listener).
  console.error(
    JSON.stringify({
      event: "[billing:lock] pool_error",
      message: err instanceof Error ? err.message : String(err),
    })
  );
});

/** Único namespace usado hoy. Mantenerlo como constante evita que un
 * camino nuevo invente un string de namespace distinto por error — ver
 * comentario de arriba. */
export const SUBSCRIPTION_LIFECYCLE_NAMESPACE = "gesty:billing:subscription_lifecycle";

const DEFAULT_MAX_WAIT_MS = 5_000;
const POLL_INTERVAL_MS = 120;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deriva dos enteros de 32 bits (el par que acepta `pg_advisory_lock(int,
 * int)`) de forma determinística a partir de `namespace:key`, vía SHA-256.
 *
 * Se usa el par de `int4` en vez de un único `bigint` calculado con
 * `hashtext()` (lo que hacía el código anterior): `hashtext()` devuelve un
 * único entero de 32 bits, así que el espacio de claves distintas es de
 * ~4.29×10^9 — con suficientes negocios concurrentes, el cumpleaños hace
 * las colisiones no despreciables, y DOS negocios distintos colisionando
 * en la misma clave advisory serializarían sus mutaciones entre sí sin
 * necesidad (correctness no se rompe — el lock es más amplio de lo
 * necesario — pero sí la latencia, de forma impredecible). El par de dos
 * `int4` derivados de un hash de 256 bits lleva el espacio efectivo a 2^64,
 * donde una colisión accidental entre dos `businessId` reales es
 * criptográficamente despreciable.
 */
function deriveLockKey(namespace: string, key: string): [number, number] {
  const digest = crypto.createHash("sha256").update(`${namespace}:${key}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export class BillingLockTimeoutError extends Error {
  readonly status = 409;
  constructor(message = "Hay otra operación de facturación en curso para este negocio. Reintentá en unos segundos.") {
    super(message);
    this.name = "BillingLockTimeoutError";
  }
}

export class BillingLockUnavailableError extends Error {
  readonly status = 503;
  constructor(message = "No se pudo coordinar la operación de facturación. Reintentá en unos segundos.") {
    super(message);
    this.name = "BillingLockUnavailableError";
  }
}

/**
 * Adquiere el advisory lock de SESIÓN (no transaccional: `pg_advisory_lock`,
 * no `pg_advisory_xact_lock`) para `namespace:key`, ejecuta `fn`, y libera el
 * lock de forma segura en todos los caminos — incluido cuando `fn` lanza.
 *
 * Contrato que cumple (ver tarea "Fase 2", sección 3):
 *  1-2. El lock se adquiere ANTES de que `fn` pueda leer o decidir nada, y
 *     se mantiene durante toda la ejecución de `fn` (lectura, validación,
 *     llamada a Stripe, reconciliación/persistencia).
 *  3. La conexión dedicada de este pool NUNCA abre una transacción —
 *     ejecuta únicamente `pg_try_advisory_lock`/`pg_advisory_unlock`. Las
 *     queries de negocio dentro de `fn` siguen usando el pool de Prisma con
 *     transacciones cortas normales, ninguna abarca la llamada a Stripe.
 *  4. Libera siempre: éxito, error de `fn`, o fallo al adquirir.
 *  5. Espera acotada (`maxWaitMs`, default 5s) con `pg_try_advisory_lock` en
 *     loop — si no se consigue, `BillingLockTimeoutError` (409).
 *  6. Si no se adquiere el lock, `fn` nunca se invoca.
 *  7. Si el `unlock` falla (la query en sí lanza, no que devuelva `false`),
 *     la conexión se destruye (`client.release(true)`) en vez de volver al
 *     pool — Postgres libera el advisory lock por su cuenta al terminar esa
 *     sesión, así que no queda un lock fantasma sostenido por una conexión
 *     que ya no controlamos.
 */
export async function withBillingLock<T>(
  namespace: string,
  key: string,
  fn: () => Promise<T>,
  opts?: { maxWaitMs?: number }
): Promise<T> {
  const [key1, key2] = deriveLockKey(namespace, key);
  const maxWaitMs = opts?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  let client: PoolClient;
  try {
    client = await lockPool.connect();
  } catch (err) {
    throw new BillingLockUnavailableError(
      err instanceof Error ? `No se pudo coordinar la operación: ${err.message}` : undefined
    );
  }

  // Fase 1: adquirir. Cualquier falla acá (timeout controlado, o la query
  // de `pg_try_advisory_lock` en sí lanzando) termina con la conexión
  // resuelta (liberada o destruida) ANTES de propagar el error — nunca se
  // llega a invocar `fn()` sin el lock, y nunca se deja la conexión sin
  // resolver.
  try {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const { rows } = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1, $2) AS locked",
        [key1, key2]
      );
      if (rows[0]?.locked) break;
      if (Date.now() >= deadline) {
        throw new BillingLockTimeoutError();
      }
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (err) {
    if (err instanceof BillingLockTimeoutError) {
      // Nunca se tomó el lock: la conexión en sí sigue sana.
      client.release();
    } else {
      // La query de adquisición lanzó (ej. la conexión se cayó a mitad de
      // intento): no sabemos en qué estado quedó, se destruye.
      client.release(true);
    }
    throw err;
  }

  // Fase 2: lock tomado. A partir de acá, SIEMPRE se intenta liberar en el
  // `finally`, sin importar cómo termine `fn()`.
  try {
    return await fn();
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock($1, $2) AS unlocked", [key1, key2]);
      client.release();
    } catch (unlockErr) {
      console.error(
        JSON.stringify({
          event: "[billing:lock] unlock_failed_destroying_connection",
          namespace,
          message: unlockErr instanceof Error ? unlockErr.message : String(unlockErr),
        })
      );
      // No sabemos si el advisory lock quedó realmente liberado del lado
      // de Postgres. En vez de devolver al pool una conexión cuyo estado
      // de lock es incierto (lo que podría dejar esa conexión "pegada"
      // sosteniendo el lock para siempre mientras viva en el pool), la
      // destruimos: Postgres libera cualquier advisory lock de sesión en
      // cuanto la conexión termina.
      client.release(true);
    }
  }
}

/** Solo para shutdown ordenado / tests. */
export async function closeBillingLockPool(): Promise<void> {
  await lockPool.end();
}
