-- Fase 3 de docs/arquitectura/POS_TECHNICAL_DESIGN.md: agrega `DINE_IN` al enum
-- `FulfillmentType` y `orders.table_tab_id` (nullable) para que una ronda de
-- salón sea una `orders` real, vinculada a su `table_tab`, sin tocar el flujo
-- de delivery/take-away existente (ambos siguen con `table_tab_id = NULL`).
--
-- NOTA DE PROCESO (igual a 20261013220000_add_checkout_attempt y
-- 20261109120000_add_table_tab): escrito a mano, NO SE EJECUTÓ todavía contra
-- ninguna base real al momento de escribir este archivo. Ver cabecera de
-- 20261109120000_add_table_tab sobre `prisma/schema.prisma` como fuente de
-- verdad y sobre qué `DATABASE_URL` usar.
--
-- IDEMPOTENCIA: `ADD VALUE IF NOT EXISTS` (soportado dentro de transacción
-- desde Postgres 12; este repo corre Postgres 17), `IF NOT EXISTS` en la
-- columna, y chequeo manual de constraint — correrlo dos veces es un no-op.

BEGIN;

ALTER TYPE "FulfillmentType" ADD VALUE IF NOT EXISTS 'DINE_IN';

ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "table_tab_id" UUID;

CREATE INDEX IF NOT EXISTS "idx_orders_table_tab"
    ON "orders"("table_tab_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_orders_table_tab'
    ) THEN
        ALTER TABLE "orders"
            ADD CONSTRAINT "fk_orders_table_tab"
            FOREIGN KEY ("table_tab_id") REFERENCES "table_tab"("id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;
END $$;

COMMIT;
