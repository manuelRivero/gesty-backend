/**
 * Prueba de integración REAL contra PostgreSQL para la facturación
 * consolidada del consumo de salón (`billable_charge`/`billable_charge_line`
 * + la generalización de `fiscal_invoice`, Fase 7 de
 * `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.E`).
 *
 * No corre en la suite normal (`npm test` / `npx vitest run`) salvo que se
 * defina `BILLABLE_CHARGE_TEST_DATABASE_URL`, apuntando a un Postgres
 * descartable (NUNCA a la base de desarrollo/producción de este repo — este
 * test hace DROP TABLE). Si no está definida, el `describe` entero se salta
 * (`describe.skipIf`), sin fallar la suite. Mismo patrón que el resto de
 * `*.postgres.integration.test.ts` de este repo.
 *
 * CÓMO EJECUTARLA:
 *
 *   docker compose -f docker-compose.postgres.yml up -d
 *   BILLABLE_CHARGE_TEST_DATABASE_URL="postgresql://<user>:<pass>@localhost:<puerto>/<db>" \
 *     npx vitest run src/services/__tests__/billableCharge.postgres.integration.test.ts
 *
 * LIMITACIÓN DOCUMENTADA (misma que el resto de `*.postgres.integration.test.ts`
 * de este repo): valida el MECANISMO de Postgres (CHECK constraint
 * order_id/billable_charge_id mutuamente excluyentes, índice único parcial de
 * idempotencia de factura por billable_charge, integridad referencial de
 * `billable_charge_line`, y el cálculo de remanente facturable replicado por
 * SQL crudo tal como lo hace `billableCharge.service.ts`) — no invoca las
 * funciones TypeScript del servicio carácter por carácter, misma limitación
 * del singleton `PrismaClient` ya documentada en
 * `adminTableTab.postgres.integration.test.ts`. `orders`/`order_item`/
 * `fiscal_invoice` aquí son tablas mínimas autocontenidas, no el esquema
 * completo de la app.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DB_URL = process.env.BILLABLE_CHARGE_TEST_DATABASE_URL;

const TABLE_TAB_MIGRATION_SQL_PATH = join(
  __dirname,
  '../../../prisma/migrations/20261109120000_add_table_tab/migration.sql'
);
const BILLABLE_CHARGE_MIGRATION_SQL_PATH = join(
  __dirname,
  '../../../prisma/migrations/20261110100000_add_billable_charge/migration.sql'
);

describe.skipIf(!TEST_DB_URL)(
  'billable_charge / billable_charge_line / fiscal_invoice — doble facturación, CHECK e idempotencia contra PostgreSQL real',
  () => {
    let pool: Pool;
    const businessId = randomUUID();
    const tableId = randomUUID();
    const tableTabId = randomUUID();
    const orderId = randomUUID();
    let orderItemId: string;

    beforeAll(async () => {
      pool = new Pool({ connectionString: TEST_DB_URL });

      await pool.query('DROP TABLE IF EXISTS fiscal_invoice CASCADE');
      await pool.query('DROP TABLE IF EXISTS billable_charge_line CASCADE');
      await pool.query('DROP TABLE IF EXISTS billable_charge CASCADE');
      await pool.query('DROP TYPE IF EXISTS "BillableChargeStatus"');
      await pool.query('DROP TABLE IF EXISTS order_item CASCADE');
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

      // `orders`/`order_item`/`fiscal_invoice` mínimas — solo lo que esta
      // prueba necesita, no el esquema real. `fiscal_invoice` se crea en el
      // estado PRE-Fase 7 (order_id NOT NULL, sin billable_charge_id) para
      // que la migración bajo prueba sea la que hace la transición real.
      await pool.query('CREATE TABLE orders (id UUID PRIMARY KEY, business_id UUID NOT NULL, table_tab_id UUID)');
      await pool.query(`
        CREATE TABLE order_item (
          id UUID PRIMARY KEY,
          order_id UUID NOT NULL,
          quantity INTEGER NOT NULL,
          unit_price DECIMAL(12, 2) NOT NULL,
          discount_amount DECIMAL(12, 2)
        )
      `);
      await pool.query(`
        CREATE TABLE fiscal_invoice (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id UUID NOT NULL,
          order_id UUID NOT NULL,
          kind TEXT NOT NULL DEFAULT 'invoice',
          amount DECIMAL(12, 2) NOT NULL DEFAULT 0
        )
      `);

      await pool.query(readFileSync(BILLABLE_CHARGE_MIGRATION_SQL_PATH, 'utf-8'));

      await pool.query('INSERT INTO business (id) VALUES ($1)', [businessId]);
      await pool.query('INSERT INTO "table" (id) VALUES ($1)', [tableId]);
      await pool.query(
        `INSERT INTO table_tab (id, business_id, status) VALUES ($1, $2, 'open')`,
        [tableTabId, businessId]
      );
      await pool.query('INSERT INTO orders (id, business_id, table_tab_id) VALUES ($1, $2, $3)', [
        orderId,
        businessId,
        tableTabId
      ]);
      const item = await pool.query(
        'INSERT INTO order_item (id, order_id, quantity, unit_price) VALUES ($1, $2, 3, 10.00) RETURNING id',
        [randomUUID(), orderId]
      );
      orderItemId = item.rows[0].id;
    });

    afterAll(async () => {
      await pool.query('DROP TABLE IF EXISTS fiscal_invoice CASCADE');
      await pool.query('DROP TABLE IF EXISTS billable_charge_line CASCADE');
      await pool.query('DROP TABLE IF EXISTS billable_charge CASCADE');
      await pool.query('DROP TYPE IF EXISTS "BillableChargeStatus"');
      await pool.query('DROP TABLE IF EXISTS order_item CASCADE');
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
      await pool.query('DELETE FROM fiscal_invoice');
      await pool.query('DELETE FROM billable_charge_line');
      await pool.query('DELETE FROM billable_charge');
    });

    /**
     * Replica, por SQL crudo, la validación de remanente de
     * `createBillableCharge`: `order_item.quantity − Σ quantity_billed` ya
     * confirmada en `billable_charge_line`.
     */
    async function getRemaining(itemId: string): Promise<number> {
      const { rows } = await pool.query(
        `SELECT oi.quantity - COALESCE(SUM(bcl.quantity_billed), 0) AS remaining
         FROM order_item oi
         LEFT JOIN billable_charge_line bcl ON bcl.order_item_id = oi.id
         WHERE oi.id = $1
         GROUP BY oi.quantity`,
        [itemId]
      );
      return Number(rows[0].remaining);
    }

    it('remanente facturable: decrece con cada billable_charge_line confirmada, nunca permite facturar de más', async () => {
      expect(await getRemaining(orderItemId)).toBe(3);

      const charge1 = await pool.query(
        `INSERT INTO billable_charge (business_id, table_tab_id, amount) VALUES ($1, $2, 20) RETURNING id`,
        [businessId, tableTabId]
      );
      await pool.query(
        'INSERT INTO billable_charge_line (billable_charge_id, order_item_id, quantity_billed) VALUES ($1, $2, 2)',
        [charge1.rows[0].id, orderItemId]
      );
      expect(await getRemaining(orderItemId)).toBe(1);

      // Un segundo billable_charge solo puede tomar el remanente (1), nunca más.
      const charge2 = await pool.query(
        `INSERT INTO billable_charge (business_id, table_tab_id, amount) VALUES ($1, $2, 10) RETURNING id`,
        [businessId, tableTabId]
      );
      await pool.query(
        'INSERT INTO billable_charge_line (billable_charge_id, order_item_id, quantity_billed) VALUES ($1, $2, 1)',
        [charge2.rows[0].id, orderItemId]
      );
      expect(await getRemaining(orderItemId)).toBe(0);
    });

    it('CHECK constraint: fiscal_invoice exige exactamente uno de order_id/billable_charge_id, nunca ambos ni ninguno', async () => {
      const charge = await pool.query(
        `INSERT INTO billable_charge (business_id, table_tab_id, amount) VALUES ($1, $2, 10) RETURNING id`,
        [businessId, tableTabId]
      );
      const billableChargeId = charge.rows[0].id;

      // Solo order_id: ok (flujo e-commerce existente).
      await expect(
        pool.query('INSERT INTO fiscal_invoice (business_id, order_id) VALUES ($1, $2)', [
          businessId,
          orderId
        ])
      ).resolves.toBeDefined();

      // Solo billable_charge_id: ok (Fase 7).
      await expect(
        pool.query(
          'INSERT INTO fiscal_invoice (business_id, order_id, billable_charge_id) VALUES ($1, NULL, $2)',
          [businessId, billableChargeId]
        )
      ).resolves.toBeDefined();

      // Ambos presentes: rechazado.
      await expect(
        pool.query(
          'INSERT INTO fiscal_invoice (business_id, order_id, billable_charge_id) VALUES ($1, $2, $3)',
          [businessId, orderId, billableChargeId]
        )
      ).rejects.toMatchObject({ code: '23514' });

      // Ninguno presente: rechazado.
      await expect(
        pool.query(
          'INSERT INTO fiscal_invoice (business_id, order_id, billable_charge_id) VALUES ($1, NULL, NULL)',
          [businessId]
        )
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('idempotencia de emisión por billable_charge: único por (business_id, billable_charge_id, kind)', async () => {
      const charge = await pool.query(
        `INSERT INTO billable_charge (business_id, table_tab_id, amount) VALUES ($1, $2, 10) RETURNING id`,
        [businessId, tableTabId]
      );
      const billableChargeId = charge.rows[0].id;

      await pool.query(
        'INSERT INTO fiscal_invoice (business_id, order_id, billable_charge_id, kind) VALUES ($1, NULL, $2, $3)',
        [businessId, billableChargeId, 'invoice']
      );

      // Mismo billable_charge, mismo kind: rechazado (reintento de la misma emisión).
      await expect(
        pool.query(
          'INSERT INTO fiscal_invoice (business_id, order_id, billable_charge_id, kind) VALUES ($1, NULL, $2, $3)',
          [businessId, billableChargeId, 'invoice']
        )
      ).rejects.toMatchObject({ code: '23505' });

      // Mismo billable_charge, kind distinto (p. ej. nota de crédito): no colisiona.
      await expect(
        pool.query(
          'INSERT INTO fiscal_invoice (business_id, order_id, billable_charge_id, kind) VALUES ($1, NULL, $2, $3)',
          [businessId, billableChargeId, 'credit_note']
        )
      ).resolves.toBeDefined();
    });

    it('integridad referencial: borrar un billable_charge elimina en cascada sus líneas', async () => {
      const charge = await pool.query(
        `INSERT INTO billable_charge (business_id, table_tab_id, amount) VALUES ($1, $2, 10) RETURNING id`,
        [businessId, tableTabId]
      );
      await pool.query(
        'INSERT INTO billable_charge_line (billable_charge_id, order_item_id, quantity_billed) VALUES ($1, $2, 1)',
        [charge.rows[0].id, orderItemId]
      );

      await pool.query('DELETE FROM billable_charge WHERE id = $1', [charge.rows[0].id]);

      const { rows } = await pool.query(
        'SELECT * FROM billable_charge_line WHERE billable_charge_id = $1',
        [charge.rows[0].id]
      );
      expect(rows).toHaveLength(0);
    });
  }
);
