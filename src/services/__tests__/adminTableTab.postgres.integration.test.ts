/**
 * Prueba de integración REAL contra PostgreSQL para la apertura/transferencia/
 * cierre físico de cuenta de salón (`table_tab`/`table_tab_table`, Fase 2 de
 * `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.A/§4.B`).
 *
 * No corre en la suite normal (`npm test` / `npx vitest run`) salvo que se
 * defina `TABLE_TAB_TEST_DATABASE_URL`, apuntando a un Postgres descartable
 * (NUNCA a la base de desarrollo/producción de este repo — este test hace
 * DROP TABLE). Si no está definida, el `describe` entero se salta
 * (`describe.skipIf`), sin fallar la suite. Mismo patrón que
 * `src/services/billing/__tests__/checkoutAttempt.postgres.integration.test.ts`.
 *
 * CÓMO EJECUTARLA:
 *
 *   docker compose -f docker-compose.postgres.yml up -d
 *   TABLE_TAB_TEST_DATABASE_URL="postgresql://<user>:<pass>@localhost:<puerto>/<db>" \
 *     npx vitest run src/services/__tests__/adminTableTab.postgres.integration.test.ts
 *
 * LIMITACIÓN DOCUMENTADA (misma que `checkoutAttempt.postgres.integration.test.ts`):
 * el `PrismaClient` de este repo (`src/lib/prisma.ts`) es un singleton atado a
 * un único `Pool`/`DATABASE_URL` global leído al importar el módulo — no hay
 * forma de instanciar "dos negocios de prueba con conexiones distintas" sin
 * reescribir los servicios para aceptar un cliente inyectado (fuera de
 * alcance de esta entrega). Por eso esta prueba valida el MECANISMO de
 * Postgres (advisory lock por mesa + índice único parcial) que
 * `adminTableTab.service.ts` usa, ejecutando la migración real contra un
 * esquema mínimo y autocontenido, en vez de invocar las funciones TypeScript
 * del servicio carácter por carácter.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DB_URL = process.env.TABLE_TAB_TEST_DATABASE_URL;

const MIGRATION_SQL_PATH = join(
  __dirname,
  '../../../prisma/migrations/20261109120000_add_table_tab/migration.sql'
);

describe.skipIf(!TEST_DB_URL)(
  'table_tab / table_tab_table — apertura, transferencia y cierre físico contra PostgreSQL real',
  () => {
    let poolA: Pool;
    let poolB: Pool;
    const businessId = randomUUID();
    const tableAId = randomUUID();
    const tableBId = randomUUID();

    beforeAll(async () => {
      poolA = new Pool({ connectionString: TEST_DB_URL });
      poolB = new Pool({ connectionString: TEST_DB_URL });

      // Esquema mínimo y autocontenido: solo lo que las FKs de la migración
      // real necesitan (`business`, `business_user`, `table`), reducidas a
      // su PK — no el esquema completo de la app. Igual criterio que
      // `checkoutAttempt.postgres.integration.test.ts`.
      await poolA.query('DROP TABLE IF EXISTS table_tab_table CASCADE');
      await poolA.query('DROP TABLE IF EXISTS table_tab CASCADE');
      await poolA.query('DROP TYPE IF EXISTS "TableTabStatus"');
      await poolA.query('DROP TABLE IF EXISTS "table" CASCADE');
      await poolA.query('DROP TABLE IF EXISTS business_user CASCADE');
      await poolA.query('DROP TABLE IF EXISTS business CASCADE');

      await poolA.query('CREATE TABLE business (id UUID PRIMARY KEY)');
      await poolA.query('CREATE TABLE business_user (id UUID PRIMARY KEY)');
      await poolA.query('CREATE TABLE "table" (id UUID PRIMARY KEY)');

      const migrationSql = readFileSync(MIGRATION_SQL_PATH, 'utf-8');
      await poolA.query(migrationSql);

      await poolA.query('INSERT INTO business (id) VALUES ($1)', [businessId]);
      await poolA.query('INSERT INTO "table" (id) VALUES ($1), ($2)', [tableAId, tableBId]);
    });

    afterAll(async () => {
      await poolA.query('DROP TABLE IF EXISTS table_tab_table CASCADE');
      await poolA.query('DROP TABLE IF EXISTS table_tab CASCADE');
      await poolA.query('DROP TYPE IF EXISTS "TableTabStatus"');
      await poolA.query('DROP TABLE IF EXISTS "table" CASCADE');
      await poolA.query('DROP TABLE IF EXISTS business_user CASCADE');
      await poolA.query('DROP TABLE IF EXISTS business CASCADE');
      await poolA.end();
      await poolB.end();
    });

    beforeEach(async () => {
      await poolA.query('DELETE FROM table_tab_table');
      await poolA.query('DELETE FROM table_tab');
    });

    /**
     * Replica, por SQL crudo sobre una conexión dada, exactamente la
     * secuencia de `openTableTab` (`adminTableTab.service.ts`): advisory
     * lock transaccional por `(business_id, table_id)`, relectura de
     * asignación activa, creación de `table_tab` + `table_tab_table` si no
     * hay ninguna. Ver limitación documentada arriba sobre por qué no se
     * invoca la función real.
     */
    async function openViaRawSql(pool: Pool, bizId: string, tableId: string) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `table-tab:table:${bizId}:${tableId}`,
        ]);
        const active = await client.query(
          'SELECT * FROM table_tab_table WHERE table_id = $1 AND unassigned_at IS NULL',
          [tableId]
        );
        if (active.rows[0]) {
          await client.query('COMMIT');
          return { assignment: active.rows[0], isNew: false };
        }
        const tab = await client.query(
          `INSERT INTO table_tab (business_id, status) VALUES ($1, 'open') RETURNING *`,
          [bizId]
        );
        const inserted = await client.query(
          `INSERT INTO table_tab_table (table_tab_id, table_id) VALUES ($1, $2) RETURNING *`,
          [tab.rows[0].id, tableId]
        );
        await client.query('COMMIT');
        return { assignment: inserted.rows[0], isNew: true };
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    }

    it('dos conexiones abriendo cuenta sobre la MISMA mesa al mismo tiempo: solo una crea la asignación activa', async () => {
      const [a, b] = await Promise.all([
        openViaRawSql(poolA, businessId, tableAId),
        openViaRawSql(poolB, businessId, tableAId),
      ]);

      const newOnes = [a, b].filter((r) => r.isNew);
      expect(newOnes).toHaveLength(1);

      const { rows } = await poolA.query(
        'SELECT * FROM table_tab_table WHERE table_id = $1 AND unassigned_at IS NULL',
        [tableAId]
      );
      expect(rows).toHaveLength(1);
      expect(a.assignment.table_tab_id).toEqual(b.assignment.table_tab_id);
    });

    it('dos mesas DISTINTAS abiertas al mismo tiempo no se bloquean entre sí (locks por mesa, no por negocio)', async () => {
      const [a, b] = await Promise.all([
        openViaRawSql(poolA, businessId, tableAId),
        openViaRawSql(poolB, businessId, tableBId),
      ]);

      expect(a.isNew).toBe(true);
      expect(b.isNew).toBe(true);
      expect(a.assignment.table_tab_id).not.toEqual(b.assignment.table_tab_id);
    });

    it('si se pierde la exclusión de aplicación (dos INSERT directos sin el advisory lock), el índice único parcial sigue evitando dos asignaciones activas', async () => {
      const tab = await poolA.query(
        `INSERT INTO table_tab (business_id, status) VALUES ($1, 'open') RETURNING id`,
        [businessId]
      );
      const tabId = tab.rows[0].id;

      const insertWithoutLock = (pool: Pool) =>
        pool.query(
          'INSERT INTO table_tab_table (table_tab_id, table_id) VALUES ($1, $2) RETURNING *',
          [tabId, tableAId]
        );

      const results = await Promise.allSettled([
        insertWithoutLock(poolA),
        insertWithoutLock(poolB),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      // Código de Postgres para unique_violation — confirma que es el índice
      // único parcial el que rechazó, no otra restricción.
      expect((rejected[0] as PromiseRejectedResult).reason.code).toBe('23505');
    });

    it('transferencia: cierra la fila activa vieja y abre una nueva, sin editarla, dejando el historial intacto', async () => {
      const opened = await openViaRawSql(poolA, businessId, tableAId);
      const tabId = opened.assignment.table_tab_id;

      await poolA.query('BEGIN');
      await poolA.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `table-tab:table:${businessId}:${tableAId}`,
      ]);
      await poolA.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `table-tab:table:${businessId}:${tableBId}`,
      ]);
      await poolA.query(
        'UPDATE table_tab_table SET unassigned_at = now() WHERE id = $1',
        [opened.assignment.id]
      );
      await poolA.query(
        'INSERT INTO table_tab_table (table_tab_id, table_id) VALUES ($1, $2)',
        [tabId, tableBId]
      );
      await poolA.query('COMMIT');

      const { rows: active } = await poolA.query(
        'SELECT * FROM table_tab_table WHERE table_tab_id = $1 AND unassigned_at IS NULL',
        [tabId]
      );
      expect(active).toHaveLength(1);
      expect(active[0].table_id).toEqual(tableBId);

      const { rows: history } = await poolA.query(
        'SELECT * FROM table_tab_table WHERE table_tab_id = $1 ORDER BY assigned_at',
        [tabId]
      );
      expect(history).toHaveLength(2);
      expect(history[0].table_id).toEqual(tableAId);
      expect(history[0].unassigned_at).not.toBeNull();

      // La mesa vieja queda libre: una cuenta nueva puede abrirse sobre ella.
      const reopened = await openViaRawSql(poolB, businessId, tableAId);
      expect(reopened.isNew).toBe(true);
    });

    it('cierre: libera todas las asignaciones activas de la cuenta y marca la cuenta como closed', async () => {
      const opened = await openViaRawSql(poolA, businessId, tableAId);
      const tabId = opened.assignment.table_tab_id;
      // Agrupa una segunda mesa a la misma cuenta antes de cerrar.
      await poolA.query(
        'INSERT INTO table_tab_table (table_tab_id, table_id) VALUES ($1, $2)',
        [tabId, tableBId]
      );

      await poolA.query('BEGIN');
      await poolA.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `table-tab:tab:${businessId}:${tabId}`,
      ]);
      await poolA.query(
        'UPDATE table_tab_table SET unassigned_at = now() WHERE table_tab_id = $1 AND unassigned_at IS NULL',
        [tabId]
      );
      await poolA.query(
        `UPDATE table_tab SET status = 'closed', closed_at = now() WHERE id = $1`,
        [tabId]
      );
      await poolA.query('COMMIT');

      const { rows: active } = await poolA.query(
        'SELECT * FROM table_tab_table WHERE table_tab_id = $1 AND unassigned_at IS NULL',
        [tabId]
      );
      expect(active).toHaveLength(0);

      const { rows: tab } = await poolA.query('SELECT status FROM table_tab WHERE id = $1', [tabId]);
      expect(tab[0].status).toBe('closed');

      // Ambas mesas quedan libres: pueden abrirse cuentas nuevas sobre cada una.
      const reopenedA = await openViaRawSql(poolA, businessId, tableAId);
      const reopenedB = await openViaRawSql(poolB, businessId, tableBId);
      expect(reopenedA.isNew).toBe(true);
      expect(reopenedB.isNew).toBe(true);
    });
  }
);
