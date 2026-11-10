-- Fase 4 de docs/arquitectura/POS_TECHNICAL_DESIGN.md: comandas y estaciones de
-- preparación. Agrega `preparation_station`, el ruteo 1:1 `menu_item_station`, y el
-- par `kitchen_ticket`/`kitchen_ticket_item` (+ su historial `kitchen_ticket_item_event`).
-- No toca `orders.status` / `OrderStatus` — el pipeline de cocina es una máquina de
-- estados completamente separada (ver nota en el modelo `kitchen_ticket_item`).
--
-- NOTA DE PROCESO (misma convención que 20261109120000_add_table_tab /
-- 20261109130000_add_dine_in_fulfillment): escrito a mano, sin `prisma migrate deploy`
-- automatizado en este repo. Este repo es la única fuente de verdad del esquema
-- (ver README.md / DEPLOY.md §7.2) — aplicar manualmente contra la base de desarrollo
-- confirmada, nunca contra staging/producción.
--
-- IDEMPOTENCIA: `IF NOT EXISTS` / chequeo manual de constraint, dentro de una única
-- transacción — correrlo dos veces seguidas es un no-op, y un corte a mitad de camino
-- hace ROLLBACK completo.

BEGIN;

DO $$ BEGIN
  CREATE TYPE "KitchenTicketItemStatus" AS ENUM ('pending', 'preparing', 'ready', 'canceled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "preparation_station" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "name"        TEXT NOT NULL,
    "is_active"   BOOLEAN NOT NULL DEFAULT true,
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "preparation_station_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "menu_item_station" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "menu_item_id" UUID NOT NULL,
    "station_id"   UUID NOT NULL,

    CONSTRAINT "menu_item_station_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kitchen_ticket" (
    "id"         UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_id"   UUID NOT NULL,
    "station_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "kitchen_ticket_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kitchen_ticket_item" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "kitchen_ticket_id" UUID NOT NULL,
    "order_item_id"     UUID NOT NULL,
    "status"            "KitchenTicketItemStatus" NOT NULL DEFAULT 'pending',
    "created_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"        TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "kitchen_ticket_item_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "kitchen_ticket_item_event" (
    "id"                     UUID NOT NULL DEFAULT gen_random_uuid(),
    "kitchen_ticket_item_id" UUID NOT NULL,
    "from_status"            "KitchenTicketItemStatus",
    "to_status"              "KitchenTicketItemStatus" NOT NULL,
    "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "created_by_user_id"     UUID,

    CONSTRAINT "kitchen_ticket_item_event_pkey" PRIMARY KEY ("id")
);

-- Índices --------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "idx_preparation_station_business"
    ON "preparation_station"("business_id");

-- Ruteo simple: a lo sumo UNA estación por `menu_item` (no N:N), garantizado por
-- base de datos, no solo por la capa de aplicación.
CREATE UNIQUE INDEX IF NOT EXISTS "menu_item_station_menu_item_id_key"
    ON "menu_item_station"("menu_item_id");

CREATE INDEX IF NOT EXISTS "idx_menu_item_station_station"
    ON "menu_item_station"("station_id");

-- Clave de idempotencia de Fase 4: un reintento de generación de comandas sobre la
-- misma orden nunca duplica el ticket de una estación — hace upsert sobre esta fila.
CREATE UNIQUE INDEX IF NOT EXISTS "unique_kitchen_ticket_order_station"
    ON "kitchen_ticket"("order_id", "station_id");

CREATE INDEX IF NOT EXISTS "idx_kitchen_ticket_station"
    ON "kitchen_ticket"("station_id");

-- 1:1 con `order_item`: cada línea de orden pertenece a una única comanda.
CREATE UNIQUE INDEX IF NOT EXISTS "kitchen_ticket_item_order_item_id_key"
    ON "kitchen_ticket_item"("order_item_id");

CREATE INDEX IF NOT EXISTS "idx_kitchen_ticket_item_ticket"
    ON "kitchen_ticket_item"("kitchen_ticket_id");

CREATE INDEX IF NOT EXISTS "idx_kitchen_ticket_item_event_item"
    ON "kitchen_ticket_item_event"("kitchen_ticket_item_id");

-- Foreign keys -----------------------------------------------------------------
-- Postgres no soporta `ADD CONSTRAINT IF NOT EXISTS`; se chequea a mano, igual que
-- en el resto de prisma/migrations/*.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_preparation_station_business'
    ) THEN
        ALTER TABLE "preparation_station"
            ADD CONSTRAINT "fk_preparation_station_business"
            FOREIGN KEY ("business_id") REFERENCES "business"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_menu_item_station_menu_item'
    ) THEN
        ALTER TABLE "menu_item_station"
            ADD CONSTRAINT "fk_menu_item_station_menu_item"
            FOREIGN KEY ("menu_item_id") REFERENCES "menu_item"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_menu_item_station_station'
    ) THEN
        ALTER TABLE "menu_item_station"
            ADD CONSTRAINT "fk_menu_item_station_station"
            FOREIGN KEY ("station_id") REFERENCES "preparation_station"("id")
            ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_kitchen_ticket_order'
    ) THEN
        ALTER TABLE "kitchen_ticket"
            ADD CONSTRAINT "fk_kitchen_ticket_order"
            FOREIGN KEY ("order_id") REFERENCES "orders"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_kitchen_ticket_station'
    ) THEN
        ALTER TABLE "kitchen_ticket"
            ADD CONSTRAINT "fk_kitchen_ticket_station"
            FOREIGN KEY ("station_id") REFERENCES "preparation_station"("id")
            ON DELETE RESTRICT ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_kitchen_ticket_item_ticket'
    ) THEN
        ALTER TABLE "kitchen_ticket_item"
            ADD CONSTRAINT "fk_kitchen_ticket_item_ticket"
            FOREIGN KEY ("kitchen_ticket_id") REFERENCES "kitchen_ticket"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_kitchen_ticket_item_order_item'
    ) THEN
        ALTER TABLE "kitchen_ticket_item"
            ADD CONSTRAINT "fk_kitchen_ticket_item_order_item"
            FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_kitchen_ticket_item_event_item'
    ) THEN
        ALTER TABLE "kitchen_ticket_item_event"
            ADD CONSTRAINT "fk_kitchen_ticket_item_event_item"
            FOREIGN KEY ("kitchen_ticket_item_id") REFERENCES "kitchen_ticket_item"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

COMMIT;
