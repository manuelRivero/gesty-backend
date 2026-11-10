/**
 * Prueba de integración REAL contra PostgreSQL para el ledger de pagos de
 * cuenta (`tab_payment`/`tab_payment_application`, Fase 6 de
 * `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.D`).
 *
 * No corre en la suite normal (`npm test` / `npx vitest run`) salvo que se
 * defina `TAB_PAYMENT_TEST_DATABASE_URL`, apuntando a un Postgres descartable
 * (NUNCA a la base de desarrollo/producción de este repo — este test hace
 * DROP TABLE). Si no está definida, el `describe` entero se salta
 * (`describe.skipIf`), sin fallar la suite. Mismo patrón que el resto de
 * `*.postgres.integration.test.ts` de este repo.
 *
 * CÓMO EJECUTARLA:
 *
 *   docker compose -f docker-compose.postgres.yml up -d
 *   TAB_PAYMENT_TEST_DATABASE_URL="postgresql://<user>:<pass>@localhost:<puerto>/<db>" \
 *     npx vitest run src/services/__tests__/tabPayment.postgres.integration.test.ts
 *
 * LIMITACIÓN DOCUMENTADA (misma que los otros `*.postgres.integration.test.ts`
 * de este repo): valida el MECANISMO de Postgres (índice único parcial de
 * `idempotency_key`, integridad referencial, y el cálculo de saldo/reparto
 * FIFO replicado por SQL crudo tal como lo hace `tabPayment.service.ts`) — no
 * invoca las funciones TypeScript del servicio carácter por carácter, misma
 * limitación del singleton `PrismaClient` ya documentada en
 * `adminTableTab.postgres.integration.test.ts`. `orders` aquí es una tabla
 * mínima autocontenida (solo las columnas que esta prueba necesita), no el
 * esquema completo de la app.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DB_URL = process.env.TAB_PAYMENT_TEST_DATABASE_URL;

const TABLE_TAB_MIGRATION_SQL_PATH = join(
  __dirname,
  '../../../prisma/migrations/20261109120000_add_table_tab/migration.sql'
);
const TAB_PAYMENT_MIGRATION_SQL_PATH = join(
  __dirname,
  '../../../prisma/migrations/20261109160000_add_tab_payment/migration.sql'
);

describe.skipIf(!TEST_DB_URL)(
  'tab_payment / tab_payment_application — saldo derivado, reparto FIFO e integridad referencial contra PostgreSQL real',
  () => {
    let pool: Pool;
    const businessId = randomUUID();
    const tableId = randomUUID();
    const tableTabId = randomUUID();

    beforeAll(async () => {
      pool = new Pool({ connectionString: TEST_DB_URL });

      await pool.query('DROP TABLE IF EXISTS tab_payment_application CASCADE');
      await pool.query('DROP TABLE IF EXISTS tab_payment CASCADE');
      await pool.query('DROP TYPE IF EXISTS "TabPaymentStatus"');
      await pool.query('DROP TABLE IF EXISTS orders CASCADE');
      await pool.query('DROP TABLE IF EXISTS table_tab_table CASCADE');
      await pool.query('DROP TABLE IF EXISTS table_tab CASCADE');
      await pool.query('DROP TYPE IF EXISTS "TableTabStatus"');
      await pool.query('DROP TABLE IF EXISTS "table" CASCADE');
      await pool.query('DROP TABLE IF EXISTS business_user CASCADE');
      await pool.query('DROP TABLE IF EXISTS business CASCADE');

      await pool.query('CREATE TABLE business (id UUID PRIMARY KEY)');
      await pool.query('CREATE TABLE business_user (id UUID PRIMARY KEY)');
      await pool.query('CREATE TABLE "table" (id UUID PRIMARY KEY)');
      await pool.query(readFileSync(TABLE_TAB_MIGRATION_SQL_PATH, 'utf-8'));

      // `orders` mínima — solo lo que esta prueba necesita, no el esquema real.
      await pool.query(`
        CREATE TABLE orders (
          id UUID PRIMARY KEY,
          business_id UUID NOT NULL,
          table_tab_id UUID,
          total_amount DECIMAL(12, 2) NOT NULL,
          created_at TIMESTAMPTZ(6) NOT NULL DEFAULT now()
        )
      `);

      await pool.query(readFileSync(TAB_PAYMENT_MIGRATION_SQL_PATH, 'utf-8'));

      await pool.query('INSERT INTO business (id) VALUES ($1)', [businessId]);
      await pool.query('INSERT INTO "table" (id) VALUES ($1)', [tableId]);
      await pool.query(
        `INSERT INTO table_tab (id, business_id, status) VALUES ($1, $2, 'open')`,
        [tableTabId, businessId]
      );
      await pool.query(
        'INSERT INTO table_tab_table (table_tab_id, table_id) VALUES ($1, $2)',
        [tableTabId, tableId]
      );
    });

    afterAll(async () => {
      await pool.query('DROP TABLE IF EXISTS tab_payment_application CASCADE');
      await pool.query('DROP TABLE IF EXISTS tab_payment CASCADE');
      await pool.query('DROP TYPE IF EXISTS "TabPaymentStatus"');
      await pool.query('DROP TABLE IF EXISTS orders CASCADE');
      await pool.query('DROP TABLE IF EXISTS table_tab_table CASCADE');
      await pool.query('DROP TABLE IF EXISTS table_tab CASCADE');
      await pool.query('DROP TYPE IF EXISTS "TableTabStatus"');
      await pool.query('DROP TABLE IF EXISTS "table" CASCADE');
      await pool.query('DROP TABLE IF EXISTS business_user CASCADE');
      await pool.query('DROP TABLE IF EXISTS business CASCADE');
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query('DELETE FROM tab_payment_application');
      await pool.query('DELETE FROM tab_payment');
      await pool.query('DELETE FROM orders');
    });

    /** Inserta una orden con `total_amount` y la devuelve, para construir escenarios de deuda. */
    async function createOrder(totalAmount: string, createdAt?: Date) {
      const id = randomUUID();
      await pool.query(
        'INSERT INTO orders (id, business_id, table_tab_id, total_amount, created_at) VALUES ($1, $2, $3, $4, COALESCE($5, now()))',
        [id, businessId, tableTabId, totalAmount, createdAt ?? null]
      );
      return id;
    }

    /**
     * Replica, por SQL crudo, `getTableTabOrderDues`/`getTableTabBalance`
     * (`tabPayment.service.ts`): deuda por orden = `total_amount` menos lo ya
     * aplicado en pagos `confirmed`, solo órdenes con deuda > 0, oldest-first.
     */
    async function getOrderDues(): Promise<Array<{ orderId: string; due: number }>> {
      const { rows } = await pool.query(
        `SELECT o.id AS order_id, o.total_amount - COALESCE(applied.sum, 0) AS due
         FROM orders o
         LEFT JOIN (
           SELECT tpa.order_id, SUM(tpa.amount) AS sum
           FROM tab_payment_application tpa
           JOIN tab_payment tp ON tp.id = tpa.tab_payment_id
           WHERE tp.status = 'confirmed'
           GROUP BY tpa.order_id
         ) applied ON applied.order_id = o.id
         WHERE o.table_tab_id = $1
         ORDER BY o.created_at ASC`,
        [tableTabId]
      );
      return rows
        .map((r) => ({ orderId: r.order_id as string, due: Number(r.due) }))
        .filter((r) => r.due > 0);
    }

    it('saldo derivado: suma la deuda de todas las órdenes de la cuenta, nunca un campo cacheado', async () => {
      await createOrder('30.00');
      await createOrder('20.00');

      const dues = await getOrderDues();
      const balance = dues.reduce((sum, d) => sum + d.due, 0);
      expect(balance).toBe(50);
    });

    it('reparto FIFO: un pago parcial cubre primero la ronda más antigua', async () => {
      const older = await createOrder('30.00', new Date('2026-01-01T00:00:00Z'));
      const newer = await createOrder('20.00', new Date('2026-01-02T00:00:00Z'));

      const dues = await getOrderDues();
      expect(dues.map((d) => d.orderId)).toEqual([older, newer]);

      // Pago de 25: cubre toda la orden vieja (30→ solo puede cubrir 25, ya
      // que el pago es menor a su deuda) — FIFO no reparte hacia la más nueva
      // hasta agotar la más vieja.
      const payment = await pool.query(
        `INSERT INTO tab_payment (business_id, table_tab_id, amount_tendered, amount_applied, status)
         VALUES ($1, $2, 25, 25, 'confirmed') RETURNING id`,
        [businessId, tableTabId]
      );
      await pool.query(
        'INSERT INTO tab_payment_application (tab_payment_id, order_id, amount) VALUES ($1, $2, 25)',
        [payment.rows[0].id, older]
      );

      const duesAfter = await getOrderDues();
      expect(duesAfter).toEqual([
        { orderId: older, due: 5 },
        { orderId: newer, due: 20 }
      ]);
    });

    it('vuelto dinámico: amount_applied nunca excede la deuda, el excedente es vuelto (no se persiste)', async () => {
      const orderId = await createOrder('15.00');
      const amountTendered = 20;
      const dues = await getOrderDues();
      const totalDue = dues.reduce((s, d) => s + d.due, 0);
      const amountApplied = Math.min(amountTendered, totalDue);
      const change = amountTendered - amountApplied;

      expect(amountApplied).toBe(15);
      expect(change).toBe(5);

      const payment = await pool.query(
        `INSERT INTO tab_payment (business_id, table_tab_id, amount_tendered, amount_applied, status)
         VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
        [businessId, tableTabId, amountTendered, amountApplied]
      );
      await pool.query(
        'INSERT INTO tab_payment_application (tab_payment_id, order_id, amount) VALUES ($1, $2, $3)',
        [payment.rows[0].id, orderId, amountApplied]
      );

      // El vuelto nunca se persiste como fila propia — solo existe `amount_tendered`
      // (lo que entró) y `amount_applied` (lo aplicado); la diferencia se calcula, no se guarda.
      expect(Number(payment.rows[0].amount_tendered)).toBe(20);
      expect(Number(payment.rows[0].amount_applied)).toBe(15);

      const duesAfter = await getOrderDues();
      expect(duesAfter).toHaveLength(0);
    });

    it('idempotency_key: único por negocio cuando no es NULL, pero admite múltiples NULL', async () => {
      await pool.query(
        `INSERT INTO tab_payment (business_id, table_tab_id, amount_tendered, amount_applied, idempotency_key)
         VALUES ($1, $2, 10, 10, 'retry-key-1')`,
        [businessId, tableTabId]
      );
      // Mismo negocio, misma key: rechazado.
      await expect(
        pool.query(
          `INSERT INTO tab_payment (business_id, table_tab_id, amount_tendered, amount_applied, idempotency_key)
           VALUES ($1, $2, 10, 10, 'retry-key-1')`,
          [businessId, tableTabId]
        )
      ).rejects.toMatchObject({ code: '23505' });

      // Sin key (NULL): no colisiona entre sí, ni con la anterior.
      await pool.query(
        `INSERT INTO tab_payment (business_id, table_tab_id, amount_tendered, amount_applied)
         VALUES ($1, $2, 10, 10)`,
        [businessId, tableTabId]
      );
      await pool.query(
        `INSERT INTO tab_payment (business_id, table_tab_id, amount_tendered, amount_applied)
         VALUES ($1, $2, 10, 10)`,
        [businessId, tableTabId]
      );

      const { rows } = await pool.query('SELECT COUNT(*) FROM tab_payment WHERE business_id = $1', [
        businessId
      ]);
      expect(Number(rows[0].count)).toBe(3);
    });

    it('reverso: fila nueva con reversal_of_id y signo contrario, nunca UPDATE de la original', async () => {
      const orderId = await createOrder('10.00');
      const original = await pool.query(
        `INSERT INTO tab_payment (business_id, table_tab_id, amount_tendered, amount_applied, status)
         VALUES ($1, $2, 10, 10, 'confirmed') RETURNING id`,
        [businessId, tableTabId]
      );
      await pool.query(
        'INSERT INTO tab_payment_application (tab_payment_id, order_id, amount) VALUES ($1, $2, 10)',
        [original.rows[0].id, orderId]
      );

      const reversal = await pool.query(
        `INSERT INTO tab_payment (business_id, table_tab_id, amount_tendered, amount_applied, status, reversal_of_id)
         VALUES ($1, $2, -10, -10, 'confirmed', $3) RETURNING id`,
        [businessId, tableTabId, original.rows[0].id]
      );
      await pool.query(
        'INSERT INTO tab_payment_application (tab_payment_id, order_id, amount) VALUES ($1, $2, -10)',
        [reversal.rows[0].id, orderId]
      );

      // La original sigue intacta (nunca se editó), y la deuda vuelve a 10
      // una vez se suman ambas aplicaciones (10 aplicado, -10 reverso).
      const { rows: originalRow } = await pool.query(
        'SELECT amount_applied FROM tab_payment WHERE id = $1',
        [original.rows[0].id]
      );
      expect(Number(originalRow[0].amount_applied)).toBe(10);

      const dues = await getOrderDues();
      expect(dues).toEqual([{ orderId, due: 10 }]);
    });

    it('integridad referencial: borrar la table_tab elimina en cascada sus pagos y aplicaciones', async () => {
      const orderId = await createOrder('10.00');
      const payment = await pool.query(
        `INSERT INTO tab_payment (business_id, table_tab_id, amount_tendered, amount_applied)
         VALUES ($1, $2, 10, 10) RETURNING id`,
        [businessId, tableTabId]
      );
      await pool.query(
        'INSERT INTO tab_payment_application (tab_payment_id, order_id, amount) VALUES ($1, $2, 10)',
        [payment.rows[0].id, orderId]
      );

      await pool.query('DELETE FROM table_tab WHERE id = $1', [tableTabId]);

      const { rows: payments } = await pool.query('SELECT * FROM tab_payment WHERE id = $1', [
        payment.rows[0].id
      ]);
      expect(payments).toHaveLength(0);
      const { rows: applications } = await pool.query(
        'SELECT * FROM tab_payment_application WHERE tab_payment_id = $1',
        [payment.rows[0].id]
      );
      expect(applications).toHaveLength(0);

      // Recrear la cuenta para que `afterAll`/el resto de tests no se vean afectados.
      await pool.query(
        `INSERT INTO table_tab (id, business_id, status) VALUES ($1, $2, 'open')`,
        [tableTabId, businessId]
      );
    });
  }
);
