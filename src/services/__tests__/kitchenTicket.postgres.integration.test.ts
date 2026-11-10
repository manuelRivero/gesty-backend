/**
 * Prueba de integración REAL contra PostgreSQL para la generación de comandas
 * por estación (`kitchen_ticket`/`kitchen_ticket_item`, Fase 4 de
 * `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.B`).
 *
 * No corre en la suite normal (`npm test` / `npx vitest run`) salvo que se
 * defina `KITCHEN_TICKET_TEST_DATABASE_URL`, apuntando a un Postgres
 * descartable (NUNCA a la base de desarrollo/producción de este repo — este
 * test hace DROP TABLE). Si no está definida, el `describe` entero se salta
 * (`describe.skipIf`), sin fallar la suite. Mismo patrón que
 * `adminTableTab.postgres.integration.test.ts` /
 * `checkoutAttempt.postgres.integration.test.ts`.
 *
 * CÓMO EJECUTARLA:
 *
 *   docker compose -f docker-compose.postgres.yml up -d
 *   KITCHEN_TICKET_TEST_DATABASE_URL="postgresql://<user>:<pass>@localhost:<puerto>/<db>" \
 *     npx vitest run src/services/__tests__/kitchenTicket.postgres.integration.test.ts
 *
 * LIMITACIÓN DOCUMENTADA (misma que los otros `*.postgres.integration.test.ts`
 * de este repo): el `PrismaClient` de este repo (`src/lib/prisma.ts`) es un
 * singleton atado a un único `Pool`/`DATABASE_URL` global leído al importar
 * el módulo. Por eso esta prueba valida el MECANISMO de Postgres (índice
 * único `(order_id, station_id)` + `upsert` idempotente, 1:1
 * `order_item`↔`kitchen_ticket_item`) que `generateKitchenTickets`
 * (`adminTableTabRound.service.ts`) usa, ejecutando la migración real contra
 * un esquema mínimo y autocontenido, en vez de invocar la función TypeScript
 * del servicio carácter por carácter.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DB_URL = process.env.KITCHEN_TICKET_TEST_DATABASE_URL;

const MIGRATION_SQL_PATH = join(
  __dirname,
  '../../../prisma/migrations/20261109140000_add_kitchen_tickets/migration.sql'
);

describe.skipIf(!TEST_DB_URL)(
  'kitchen_ticket / kitchen_ticket_item — ruteo por estación e idempotencia contra PostgreSQL real',
  () => {
    let pool: Pool;
    const businessId = randomUUID();
    const orderId = randomUUID();
    const kitchenStationId = randomUUID();
    const barStationId = randomUUID();
    const kitchenMenuItemId = randomUUID();
    const barMenuItemId = randomUUID();
    const noStationMenuItemId = randomUUID();
    let kitchenOrderItemId: string;
    let barOrderItemId: string;
    let noStationOrderItemId: string;

    beforeAll(async () => {
      pool = new Pool({ connectionString: TEST_DB_URL });

      // Esquema mínimo y autocontenido: solo lo que las FKs de la migración
      // real necesitan (`business`, `orders`, `order_item`, `menu_item`),
      // reducidas a su PK — no el esquema completo de la app. Mismo criterio
      // que `adminTableTab.postgres.integration.test.ts`.
      await pool.query('DROP TABLE IF EXISTS kitchen_ticket_item_event CASCADE');
      await pool.query('DROP TABLE IF EXISTS kitchen_ticket_item CASCADE');
      await pool.query('DROP TABLE IF EXISTS kitchen_ticket CASCADE');
      await pool.query('DROP TABLE IF EXISTS menu_item_station CASCADE');
      await pool.query('DROP TABLE IF EXISTS preparation_station CASCADE');
      await pool.query('DROP TYPE IF EXISTS "KitchenTicketItemStatus"');
      await pool.query('DROP TABLE IF EXISTS order_item CASCADE');
      await pool.query('DROP TABLE IF EXISTS orders CASCADE');
      await pool.query('DROP TABLE IF EXISTS menu_item CASCADE');
      await pool.query('DROP TABLE IF EXISTS business CASCADE');

      await pool.query('CREATE TABLE business (id UUID PRIMARY KEY)');
      await pool.query('CREATE TABLE menu_item (id UUID PRIMARY KEY)');
      await pool.query('CREATE TABLE orders (id UUID PRIMARY KEY)');
      await pool.query('CREATE TABLE order_item (id UUID PRIMARY KEY)');

      const migrationSql = readFileSync(MIGRATION_SQL_PATH, 'utf-8');
      await pool.query(migrationSql);

      await pool.query('INSERT INTO business (id) VALUES ($1)', [businessId]);
      await pool.query('INSERT INTO orders (id) VALUES ($1)', [orderId]);
      await pool.query('INSERT INTO menu_item (id) VALUES ($1), ($2), ($3)', [
        kitchenMenuItemId,
        barMenuItemId,
        noStationMenuItemId,
      ]);
      await pool.query(
        `INSERT INTO preparation_station (id, business_id, name) VALUES ($1, $3, 'Cocina'), ($2, $3, 'Barra')`,
        [kitchenStationId, barStationId, businessId]
      );
      await pool.query(
        'INSERT INTO menu_item_station (menu_item_id, station_id) VALUES ($1, $2), ($3, $4)',
        [kitchenMenuItemId, kitchenStationId, barMenuItemId, barStationId]
      );

      const orderItems = await pool.query(
        'INSERT INTO order_item (id) VALUES ($1), ($2), ($3) RETURNING id',
        [randomUUID(), randomUUID(), randomUUID()]
      );
      [kitchenOrderItemId, barOrderItemId, noStationOrderItemId] = orderItems.rows.map(
        (r) => r.id
      );
    });

    afterAll(async () => {
      await pool.query('DROP TABLE IF EXISTS kitchen_ticket_item_event CASCADE');
      await pool.query('DROP TABLE IF EXISTS kitchen_ticket_item CASCADE');
      await pool.query('DROP TABLE IF EXISTS kitchen_ticket CASCADE');
      await pool.query('DROP TABLE IF EXISTS menu_item_station CASCADE');
      await pool.query('DROP TABLE IF EXISTS preparation_station CASCADE');
      await pool.query('DROP TYPE IF EXISTS "KitchenTicketItemStatus"');
      await pool.query('DROP TABLE IF EXISTS order_item CASCADE');
      await pool.query('DROP TABLE IF EXISTS orders CASCADE');
      await pool.query('DROP TABLE IF EXISTS menu_item CASCADE');
      await pool.query('DROP TABLE IF EXISTS business CASCADE');
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query('DELETE FROM kitchen_ticket_item');
      await pool.query('DELETE FROM kitchen_ticket');
    });

    /**
     * Replica, por SQL crudo, exactamente la lógica de `generateKitchenTickets`
     * (`adminTableTabRound.service.ts`): agrupa los `order_item` por la
     * estación de su `menu_item`, `upsert` del `kitchen_ticket` por
     * `(order_id, station_id)`, y crea los `kitchen_ticket_item`
     * correspondientes. Ver limitación documentada arriba sobre por qué no se
     * invoca la función TypeScript real.
     */
    async function generateTicketsViaRawSql(
      items: Array<{ orderItemId: string; menuItemId: string }>
    ) {
      const stationLinks = await pool.query(
        'SELECT menu_item_id, station_id FROM menu_item_station WHERE menu_item_id = ANY($1)',
        [items.map((i) => i.menuItemId)]
      );
      const stationByMenuItem = new Map(
        stationLinks.rows.map((r) => [r.menu_item_id, r.station_id])
      );

      const itemsByStation = new Map<string, string[]>();
      for (const item of items) {
        const stationId = stationByMenuItem.get(item.menuItemId);
        if (!stationId) continue;
        const bucket = itemsByStation.get(stationId);
        if (bucket) {
          bucket.push(item.orderItemId);
        } else {
          itemsByStation.set(stationId, [item.orderItemId]);
        }
      }

      for (const [stationId, orderItemIds] of itemsByStation) {
        const ticket = await pool.query(
          `INSERT INTO kitchen_ticket (order_id, station_id) VALUES ($1, $2)
           ON CONFLICT (order_id, station_id) DO UPDATE SET order_id = EXCLUDED.order_id
           RETURNING id`,
          [orderId, stationId]
        );
        const ticketId = ticket.rows[0].id;
        for (const orderItemId of orderItemIds) {
          await pool.query(
            'INSERT INTO kitchen_ticket_item (kitchen_ticket_id, order_item_id) VALUES ($1, $2)',
            [ticketId, orderItemId]
          );
        }
      }
    }

    it('una orden con ítems de dos estaciones genera dos kitchen_ticket independientes', async () => {
      await generateTicketsViaRawSql([
        { orderItemId: kitchenOrderItemId, menuItemId: kitchenMenuItemId },
        { orderItemId: barOrderItemId, menuItemId: barMenuItemId },
      ]);

      const { rows: tickets } = await pool.query(
        'SELECT * FROM kitchen_ticket WHERE order_id = $1 ORDER BY station_id',
        [orderId]
      );
      expect(tickets).toHaveLength(2);
      expect(new Set(tickets.map((t) => t.station_id))).toEqual(
        new Set([kitchenStationId, barStationId])
      );

      const { rows: items } = await pool.query(
        `SELECT kti.* FROM kitchen_ticket_item kti
         JOIN kitchen_ticket kt ON kt.id = kti.kitchen_ticket_id
         WHERE kt.order_id = $1`,
        [orderId]
      );
      expect(items).toHaveLength(2);
      expect(items.every((i) => i.status === 'pending')).toBe(true);
    });

    it('un menu_item sin estación asignada no genera kitchen_ticket_item, sin bloquear al resto', async () => {
      await generateTicketsViaRawSql([
        { orderItemId: kitchenOrderItemId, menuItemId: kitchenMenuItemId },
        { orderItemId: noStationOrderItemId, menuItemId: noStationMenuItemId },
      ]);

      const { rows: tickets } = await pool.query(
        'SELECT * FROM kitchen_ticket WHERE order_id = $1',
        [orderId]
      );
      expect(tickets).toHaveLength(1);
      expect(tickets[0].station_id).toEqual(kitchenStationId);

      const { rows: items } = await pool.query(
        'SELECT * FROM kitchen_ticket_item WHERE kitchen_ticket_id = $1',
        [tickets[0].id]
      );
      expect(items).toHaveLength(1);
      expect(items[0].order_item_id).toEqual(kitchenOrderItemId);
    });

    it('idempotencia: generar comandas dos veces para la misma orden/estación no duplica el kitchen_ticket', async () => {
      await generateTicketsViaRawSql([
        { orderItemId: kitchenOrderItemId, menuItemId: kitchenMenuItemId },
      ]);

      // Segunda "generación" sobre la misma orden/estación — simula un
      // reintento. El upsert sobre el índice único reutiliza la fila.
      const ticket = await pool.query(
        `INSERT INTO kitchen_ticket (order_id, station_id) VALUES ($1, $2)
         ON CONFLICT (order_id, station_id) DO UPDATE SET order_id = EXCLUDED.order_id
         RETURNING id`,
        [orderId, kitchenStationId]
      );

      const { rows: tickets } = await pool.query(
        'SELECT * FROM kitchen_ticket WHERE order_id = $1 AND station_id = $2',
        [orderId, kitchenStationId]
      );
      expect(tickets).toHaveLength(1);
      expect(tickets[0].id).toEqual(ticket.rows[0].id);
    });

    it('un menu_item no puede enrutarse a más de una estación (índice único en menu_item_station.menu_item_id)', async () => {
      await expect(
        pool.query('INSERT INTO menu_item_station (menu_item_id, station_id) VALUES ($1, $2)', [
          kitchenMenuItemId,
          barStationId,
        ])
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('un order_item no puede tener más de un kitchen_ticket_item (índice único en order_item_id)', async () => {
      const ticket = await pool.query(
        'INSERT INTO kitchen_ticket (order_id, station_id) VALUES ($1, $2) RETURNING id',
        [orderId, kitchenStationId]
      );
      await pool.query(
        'INSERT INTO kitchen_ticket_item (kitchen_ticket_id, order_item_id) VALUES ($1, $2)',
        [ticket.rows[0].id, kitchenOrderItemId]
      );

      await expect(
        pool.query(
          'INSERT INTO kitchen_ticket_item (kitchen_ticket_id, order_item_id) VALUES ($1, $2)',
          [ticket.rows[0].id, kitchenOrderItemId]
        )
      ).rejects.toMatchObject({ code: '23505' });
    });
  }
);
