/**
 * Prueba de integración REAL contra PostgreSQL para la exclusión de
 * `checkout_attempt` (ver stripeCheckout.service.ts `reserveOrGetActiveAttempt`).
 *
 * No corre en la suite normal (`npm test` / `npx vitest run`) salvo que se
 * defina `CHECKOUT_ATTEMPT_TEST_DATABASE_URL`, apuntando a un Postgres
 * descartable (NUNCA a la base de desarrollo/producción de este repo —
 * este test hace DROP TABLE). Si no está definida, el `describe` entero se
 * salta (`describe.skipIf`), sin fallar la suite.
 *
 * CÓMO EJECUTARLA:
 *
 *   # Con el Postgres local que ya trae el repo (docker-compose.postgres.yml):
 *   docker compose -f docker-compose.postgres.yml up -d
 *   CHECKOUT_ATTEMPT_TEST_DATABASE_URL="postgresql://<user>:<pass>@localhost:<puerto>/<db>" \
 *     npx vitest run src/services/billing/__tests__/checkoutAttempt.postgres.integration.test.ts
 *
 * LIMITACIÓN DOCUMENTADA (no resuelta en esta entrega): esta prueba abre
 * dos conexiones (`pg.Pool`) independientes y ejecuta DIRECTAMENTE, por SQL
 * crudo, la misma secuencia que `reserveOrGetActiveAttempt` hace a través
 * de Prisma (advisory lock → SELECT → INSERT bajo esa misma transacción),
 * en vez de invocar la función exportada del servicio. La razón: el
 * cliente Prisma de este repo (`src/lib/prisma.ts`) es un singleton atado a
 * un único `Pool`/`DATABASE_URL` global — no hay forma de instanciar "dos
 * backends" con conexiones realmente distintas sin reescribir esa función
 * para aceptar un cliente inyectado, cambio que no se hizo acá para no
 * ampliar el alcance de esta tarea. Por eso esta prueba valida el mecanismo
 * de Postgres (advisory lock + índice único parcial) que la función usa,
 * ejecutando la migración real, pero no ejercita literalmente el código
 * TypeScript de `reserveOrGetActiveAttempt` carácter por carácter. Si se
 * quiere cerrar esa brecha, la vía es parametrizar esa función para recibir
 * un `PrismaClient` (o un `Prisma.TransactionClient`) en vez de usar el
 * singleton importado — fuera de alcance de esta entrega.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DB_URL = process.env.CHECKOUT_ATTEMPT_TEST_DATABASE_URL;

const MIGRATION_SQL_PATH = join(
  __dirname,
  '../../../../prisma/migrations/20261013220000_add_checkout_attempt/migration.sql'
);

describe.skipIf(!TEST_DB_URL)(
  'checkout_attempt — exclusión real contra PostgreSQL (dos conexiones independientes)',
  () => {
    let poolA: Pool;
    let poolB: Pool;
    const businessId = randomUUID();

    beforeAll(async () => {
      poolA = new Pool({ connectionString: TEST_DB_URL });
      poolB = new Pool({ connectionString: TEST_DB_URL });

      // Esquema mínimo y autocontenido: una tabla `business` reducida a lo
      // que la FK necesita (no la tabla real de ~40 columnas), más la
      // migración REAL del feature — así esta prueba valida exactamente lo
      // que se desplegaría, sin depender del resto del esquema de la app.
      await poolA.query('DROP TABLE IF EXISTS checkout_attempt');
      await poolA.query('DROP TABLE IF EXISTS business CASCADE');
      await poolA.query('CREATE TABLE business (id UUID PRIMARY KEY)');

      const migrationSql = readFileSync(MIGRATION_SQL_PATH, 'utf-8');
      await poolA.query(migrationSql);

      await poolA.query('INSERT INTO business (id) VALUES ($1)', [businessId]);
    });

    afterAll(async () => {
      await poolA.query('DROP TABLE IF EXISTS checkout_attempt');
      await poolA.query('DROP TABLE IF EXISTS business CASCADE');
      await poolA.end();
      await poolB.end();
    });

    /**
     * Replica, por SQL crudo sobre una conexión dada, exactamente la
     * secuencia de `reserveOrGetActiveAttempt`: advisory lock transaccional
     * por `business_id`, relectura del intento activo, y creación si no
     * hay ninguno. Ver limitación documentada arriba sobre por qué no se
     * invoca la función real.
     */
    async function reserveViaRawSql(pool: Pool, bizId: string, planCode: string) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `checkout_attempt:${bizId}`,
        ]);
        const active = await client.query(
          `SELECT * FROM checkout_attempt
           WHERE business_id = $1 AND status IN ('pending','created','unresolved')
           ORDER BY created_at DESC LIMIT 1`,
          [bizId]
        );
        if (active.rows[0]) {
          await client.query('COMMIT');
          return { attempt: active.rows[0], isNew: false };
        }
        const inserted = await client.query(
          `INSERT INTO checkout_attempt (business_id, plan_code, status)
           VALUES ($1, $2, 'pending') RETURNING *`,
          [bizId, planCode]
        );
        await client.query('COMMIT');
        return { attempt: inserted.rows[0], isNew: true };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    it('dos conexiones compitiendo por el mismo business_id: solo una reserva persiste, la otra relee el intento existente', async () => {
      const [a, b] = await Promise.all([
        reserveViaRawSql(poolA, businessId, 'pro'),
        reserveViaRawSql(poolB, businessId, 'pro'),
      ]);

      const newOnes = [a, b].filter((r) => r.isNew);
      expect(newOnes).toHaveLength(1);

      const { rows } = await poolA.query(
        `SELECT * FROM checkout_attempt
         WHERE business_id = $1 AND status IN ('pending','created','unresolved')`,
        [businessId]
      );
      expect(rows).toHaveLength(1);

      // El que perdió la carrera releyó el MISMO intento (no creó el suyo
      // propio) — "el manejo del conflicto relee el intento existente y no
      // crea otra Checkout Session": acá se prueba la mitad de persistencia
      // (no se crea una segunda fila); la otra mitad (que esa relectura
      // evita además llamar a `sessions.create` de nuevo) está probada en
      // el mock de `stripeCheckout.service.test.ts`, no contra Stripe real.
      expect(a.attempt.id).toEqual(b.attempt.id);
    });

    it('si se pierde la exclusión de aplicación (dos INSERT directos sin el advisory lock), el índice único parcial sigue evitando dos reservas', async () => {
      await poolA.query('DELETE FROM checkout_attempt WHERE business_id = $1', [businessId]);

      const insertWithoutLock = (pool: Pool) =>
        pool.query(
          `INSERT INTO checkout_attempt (business_id, plan_code, status)
           VALUES ($1, 'pro', 'pending') RETURNING *`,
          [businessId]
        );

      const results = await Promise.allSettled([
        insertWithoutLock(poolA),
        insertWithoutLock(poolB),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected'
      );

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // 23505 = unique_violation en Postgres.
      expect(rejected[0].reason.code).toBe('23505');
      expect(String(rejected[0].reason.constraint)).toContain(
        'unique_business_pending_checkout_attempt'
      );
    });

    it('un intento terminal (expired) no cuenta para el índice único parcial: libera el slot de verdad', async () => {
      await poolA.query('DELETE FROM checkout_attempt WHERE business_id = $1', [businessId]);
      await poolA.query(
        `INSERT INTO checkout_attempt (business_id, plan_code, status) VALUES ($1, 'pro', 'expired')`,
        [businessId]
      );

      const { attempt, isNew } = await reserveViaRawSql(poolA, businessId, 'pro');
      expect(isNew).toBe(true);
      expect(attempt.status).toBe('pending');

      const { rows } = await poolA.query(
        `SELECT status FROM checkout_attempt WHERE business_id = $1 ORDER BY created_at`,
        [businessId]
      );
      expect(rows.map((r) => r.status).sort()).toEqual(['expired', 'pending']);
    });
  }
);
