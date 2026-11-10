/**
 * Prueba de integración REAL contra PostgreSQL para el ciclo de vida de
 * `kitchen_ticket_item` (transición de estado + anulación económica,
 * `kitchenTicketItem.service.ts`, Fase 4 de
 * `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.C`).
 *
 * No corre en la suite normal (`npm test` / `npx vitest run`) salvo que se
 * defina `KITCHEN_TICKET_ITEM_TEST_DATABASE_URL`, apuntando a un Postgres
 * descartable (NUNCA a la base de desarrollo/producción de este repo — este
 * test hace DROP TABLE). Si no está definida, el `describe` entero se salta
 * (`describe.skipIf`), sin fallar la suite. Mismo patrón que
 * `kitchenTicket.postgres.integration.test.ts`.
 *
 * CÓMO EJECUTARLA:
 *
 *   docker compose -f docker-compose.postgres.yml up -d
 *   KITCHEN_TICKET_ITEM_TEST_DATABASE_URL="postgresql://<user>:<pass>@localhost:<puerto>/<db>" \
 *     npx vitest run src/services/__tests__/kitchenTicketItemLifecycle.postgres.integration.test.ts
 *
 * LIMITACIÓN DOCUMENTADA (misma que los otros `*.postgres.integration.test.ts`
 * de este repo): valida el MECANISMO de Postgres (compare-and-swap de
 * `kitchen_ticket_item.status`, integridad referencial de
 * `order_item_adjustment`) que `kitchenTicketItem.service.ts` usa, no invoca
 * las funciones TypeScript del servicio carácter por carácter — ver la
 * limitación del singleton `PrismaClient` ya documentada en
 * `adminTableTab.postgres.integration.test.ts`.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DB_URL = process.env.KITCHEN_TICKET_ITEM_TEST_DATABASE_URL;

const KITCHEN_TICKETS_MIGRATION_SQL_PATH = join(
  __dirname,
  '../../../prisma/migrations/20261109140000_add_kitchen_tickets/migration.sql'
);
const ORDER_ITEM_ADJUSTMENT_MIGRATION_SQL_PATH = join(
  __dirname,
  '../../../prisma/migrations/20261109150000_add_order_item_adjustment/migration.sql'
);

describe.skipIf(!TEST_DB_URL)(
  'kitchen_ticket_item / order_item_adjustment — transición de estado e integridad referencial contra PostgreSQL real',
  () => {
    let poolA: Pool;
    let poolB: Pool;
    const businessId = randomUUID();
    const businessUserId = randomUUID();
    const orderId = randomUUID();
    const stationId = randomUUID();
    const menuItemId = randomUUID();

    beforeAll(async () => {
      poolA = new Pool({ connectionString: TEST_DB_URL });
      poolB = new Pool({ connectionString: TEST_DB_URL });

      await poolA.query('DROP TABLE IF EXISTS order_item_adjustment CASCADE');
      await poolA.query('DROP TYPE IF EXISTS "OrderItemAdjustmentReason"');
      await poolA.query('DROP TABLE IF EXISTS kitchen_ticket_item_event CASCADE');
      await poolA.query('DROP TABLE IF EXISTS kitchen_ticket_item CASCADE');
      await poolA.query('DROP TABLE IF EXISTS kitchen_ticket CASCADE');
      await poolA.query('DROP TABLE IF EXISTS menu_item_station CASCADE');
      await poolA.query('DROP TABLE IF EXISTS preparation_station CASCADE');
      await poolA.query('DROP TYPE IF EXISTS "KitchenTicketItemStatus"');
      await poolA.query('DROP TABLE IF EXISTS order_item CASCADE');
      await poolA.query('DROP TABLE IF EXISTS orders CASCADE');
      await poolA.query('DROP TABLE IF EXISTS menu_item CASCADE');
      await poolA.query('DROP TABLE IF EXISTS business_user CASCADE');
      await poolA.query('DROP TABLE IF EXISTS business CASCADE');

      await poolA.query('CREATE TABLE business (id UUID PRIMARY KEY)');
      await poolA.query('CREATE TABLE business_user (id UUID PRIMARY KEY)');
      await poolA.query('CREATE TABLE menu_item (id UUID PRIMARY KEY)');
      await poolA.query('CREATE TABLE orders (id UUID PRIMARY KEY)');
      await poolA.query('CREATE TABLE order_item (id UUID PRIMARY KEY)');

      await poolA.query(readFileSync(KITCHEN_TICKETS_MIGRATION_SQL_PATH, 'utf-8'));
      await poolA.query(readFileSync(ORDER_ITEM_ADJUSTMENT_MIGRATION_SQL_PATH, 'utf-8'));

      await poolA.query('INSERT INTO business (id) VALUES ($1)', [businessId]);
      await poolA.query('INSERT INTO business_user (id) VALUES ($1)', [businessUserId]);
      await poolA.query('INSERT INTO orders (id) VALUES ($1)', [orderId]);
      await poolA.query('INSERT INTO menu_item (id) VALUES ($1)', [menuItemId]);
      await poolA.query(
        `INSERT INTO preparation_station (id, business_id, name) VALUES ($1, $2, 'Cocina')`,
        [stationId, businessId]
      );
    });

    afterAll(async () => {
      await poolA.query('DROP TABLE IF EXISTS order_item_adjustment CASCADE');
      await poolA.query('DROP TYPE IF EXISTS "OrderItemAdjustmentReason"');
      await poolA.query('DROP TABLE IF EXISTS kitchen_ticket_item_event CASCADE');
      await poolA.query('DROP TABLE IF EXISTS kitchen_ticket_item CASCADE');
      await poolA.query('DROP TABLE IF EXISTS kitchen_ticket CASCADE');
      await poolA.query('DROP TABLE IF EXISTS menu_item_station CASCADE');
      await poolA.query('DROP TABLE IF EXISTS preparation_station CASCADE');
      await poolA.query('DROP TYPE IF EXISTS "KitchenTicketItemStatus"');
      await poolA.query('DROP TABLE IF EXISTS order_item CASCADE');
      await poolA.query('DROP TABLE IF EXISTS orders CASCADE');
      await poolA.query('DROP TABLE IF EXISTS menu_item CASCADE');
      await poolA.query('DROP TABLE IF EXISTS business_user CASCADE');
      await poolA.query('DROP TABLE IF EXISTS business CASCADE');
      await poolA.end();
      await poolB.end();
    });

    /** Crea un `order_item` + `kitchen_ticket`/`kitchen_ticket_item` nuevos, en `pending`. */
    async function createPendingTicketItem() {
      const orderItemId = randomUUID();
      await poolA.query('INSERT INTO order_item (id) VALUES ($1)', [orderItemId]);
      const ticket = await poolA.query(
        `INSERT INTO kitchen_ticket (order_id, station_id) VALUES ($1, $2)
         ON CONFLICT (order_id, station_id) DO UPDATE SET order_id = EXCLUDED.order_id
         RETURNING id`,
        [orderId, stationId]
      );
      const item = await poolA.query(
        'INSERT INTO kitchen_ticket_item (kitchen_ticket_id, order_item_id) VALUES ($1, $2) RETURNING id',
        [ticket.rows[0].id, orderItemId]
      );
      return { orderItemId, kitchenTicketItemId: item.rows[0].id as string };
    }

    beforeEach(async () => {
      await poolA.query('DELETE FROM order_item_adjustment');
      await poolA.query('DELETE FROM kitchen_ticket_item_event');
      await poolA.query('DELETE FROM kitchen_ticket_item');
      await poolA.query('DELETE FROM kitchen_ticket');
      await poolA.query('DELETE FROM order_item');
    });

    /**
     * Replica, por SQL crudo, el compare-and-swap de
     * `advanceKitchenTicketItemStatus`/`cancelOrderItem`: `UPDATE ... WHERE
     * status = $from` atómico — devuelve cuántas filas afectó (0 o 1).
     */
    async function casTransition(pool: Pool, id: string, from: string, to: string) {
      const result = await pool.query(
        'UPDATE kitchen_ticket_item SET status = $1 WHERE id = $2 AND status = $3',
        [to, id, from]
      );
      return result.rowCount;
    }

    it('pipeline completo pending -> preparing -> ready, con un evento por transición', async () => {
      const { kitchenTicketItemId } = await createPendingTicketItem();

      expect(await casTransition(poolA, kitchenTicketItemId, 'pending', 'preparing')).toBe(1);
      await poolA.query(
        'INSERT INTO kitchen_ticket_item_event (kitchen_ticket_item_id, from_status, to_status) VALUES ($1, $2, $3)',
        [kitchenTicketItemId, 'pending', 'preparing']
      );

      expect(await casTransition(poolA, kitchenTicketItemId, 'preparing', 'ready')).toBe(1);
      await poolA.query(
        'INSERT INTO kitchen_ticket_item_event (kitchen_ticket_item_id, from_status, to_status) VALUES ($1, $2, $3)',
        [kitchenTicketItemId, 'preparing', 'ready']
      );

      const { rows: events } = await poolA.query(
        'SELECT * FROM kitchen_ticket_item_event WHERE kitchen_ticket_item_id = $1 ORDER BY created_at',
        [kitchenTicketItemId]
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ from_status: 'pending', to_status: 'preparing' });
      expect(events[1]).toMatchObject({ from_status: 'preparing', to_status: 'ready' });

      const { rows: item } = await poolA.query(
        'SELECT status FROM kitchen_ticket_item WHERE id = $1',
        [kitchenTicketItemId]
      );
      expect(item[0].status).toBe('ready');
    });

    it('compare-and-swap: dos transiciones concurrentes pending -> preparing sobre el MISMO ítem, solo una tiene efecto', async () => {
      const { kitchenTicketItemId } = await createPendingTicketItem();

      const [a, b] = await Promise.all([
        casTransition(poolA, kitchenTicketItemId, 'pending', 'preparing'),
        casTransition(poolB, kitchenTicketItemId, 'pending', 'preparing')
      ]);

      // Una de las dos conexiones afecta la fila (count 1), la otra llega
      // tarde y no encuentra ya `status = 'pending'` (count 0).
      expect([a, b].sort()).toEqual([0, 1]);

      const { rows: item } = await poolA.query(
        'SELECT status FROM kitchen_ticket_item WHERE id = $1',
        [kitchenTicketItemId]
      );
      expect(item[0].status).toBe('preparing');
    });

    it('anulación sin motivo (ítem pending): inserta el ajuste con reason NULL', async () => {
      const { orderItemId } = await createPendingTicketItem();

      const adjustment = await poolA.query(
        `INSERT INTO order_item_adjustment (order_item_id, amount, reason, requested_by_user_id)
         VALUES ($1, $2, NULL, $3) RETURNING *`,
        [orderItemId, '-10.00', businessUserId]
      );
      expect(adjustment.rows[0].reason).toBeNull();
      expect(Number(adjustment.rows[0].amount)).toBeLessThan(0);
    });

    it('anulación con motivo (ítem preparing/ready): el motivo estructurado se persiste, referenciando el evento de cocina', async () => {
      const { orderItemId, kitchenTicketItemId } = await createPendingTicketItem();
      await poolA.query(
        'UPDATE kitchen_ticket_item SET status = $1 WHERE id = $2',
        ['preparing', kitchenTicketItemId]
      );

      const cas = await casTransition(poolA, kitchenTicketItemId, 'preparing', 'canceled');
      expect(cas).toBe(1);
      const event = await poolA.query(
        `INSERT INTO kitchen_ticket_item_event (kitchen_ticket_item_id, from_status, to_status)
         VALUES ($1, 'preparing', 'canceled') RETURNING id`,
        [kitchenTicketItemId]
      );

      const adjustment = await poolA.query(
        `INSERT INTO order_item_adjustment
           (order_item_id, amount, reason, requested_by_user_id, kitchen_ticket_item_event_id)
         VALUES ($1, $2, 'OUT_OF_STOCK', $3, $4) RETURNING *`,
        [orderItemId, '-10.00', businessUserId, event.rows[0].id]
      );
      expect(adjustment.rows[0].reason).toBe('OUT_OF_STOCK');
      expect(adjustment.rows[0].kitchen_ticket_item_event_id).toEqual(event.rows[0].id);
    });

    it('integridad referencial: borrar el order_item elimina en cascada su ajuste; borrar el business_user o el evento de cocina deja NULL en vez de romper', async () => {
      const { orderItemId, kitchenTicketItemId } = await createPendingTicketItem();
      const event = await poolA.query(
        `INSERT INTO kitchen_ticket_item_event (kitchen_ticket_item_id, from_status, to_status)
         VALUES ($1, 'pending', 'canceled') RETURNING id`,
        [kitchenTicketItemId]
      );
      const adjustment = await poolA.query(
        `INSERT INTO order_item_adjustment
           (order_item_id, amount, requested_by_user_id, kitchen_ticket_item_event_id)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [orderItemId, '-5.00', businessUserId, event.rows[0].id]
      );
      const adjustmentId = adjustment.rows[0].id;

      // Borrar el business_user no debe romper el ajuste: SET NULL.
      await poolA.query('DELETE FROM business_user WHERE id = $1', [businessUserId]);
      const { rows: afterUserDelete } = await poolA.query(
        'SELECT requested_by_user_id FROM order_item_adjustment WHERE id = $1',
        [adjustmentId]
      );
      expect(afterUserDelete[0].requested_by_user_id).toBeNull();
      await poolA.query('INSERT INTO business_user (id) VALUES ($1)', [businessUserId]);

      // Borrar el evento de cocina referenciado no debe romper el ajuste: SET NULL.
      await poolA.query('DELETE FROM kitchen_ticket_item_event WHERE id = $1', [
        event.rows[0].id
      ]);
      const { rows: afterEventDelete } = await poolA.query(
        'SELECT kitchen_ticket_item_event_id FROM order_item_adjustment WHERE id = $1',
        [adjustmentId]
      );
      expect(afterEventDelete[0].kitchen_ticket_item_event_id).toBeNull();

      // Borrar el order_item sí elimina el ajuste en cascada (nunca queda huérfano).
      await poolA.query('DELETE FROM order_item WHERE id = $1', [orderItemId]);
      const { rows: afterOrderItemDelete } = await poolA.query(
        'SELECT * FROM order_item_adjustment WHERE id = $1',
        [adjustmentId]
      );
      expect(afterOrderItemDelete).toHaveLength(0);
    });
  }
);
