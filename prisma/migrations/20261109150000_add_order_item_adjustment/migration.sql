-- Fase 4 de docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.C: anulación compensatoria
-- de un `order_item` ya confirmado. Nunca edita/borra `order_item` — es una fila
-- nueva (`order_item_adjustment`), igual que los reversos de `tab_payment`.
--
-- NOTA DE PROCESO (misma convención que las migraciones de Fase 2/3/4 previas):
-- escrito a mano, sin `prisma migrate deploy` automatizado en este repo. Este
-- repo es la única fuente de verdad del esquema — aplicar manualmente contra la
-- base de desarrollo confirmada, nunca contra staging/producción.
--
-- IDEMPOTENCIA: `IF NOT EXISTS` / chequeo manual de constraint, dentro de una
-- única transacción — correrlo dos veces seguidas es un no-op, y un corte a
-- mitad de camino hace ROLLBACK completo.

BEGIN;

DO $$ BEGIN
  CREATE TYPE "OrderItemAdjustmentReason" AS ENUM ('OUT_OF_STOCK', 'CUSTOMER_REQUEST', 'KITCHEN_ERROR', 'OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "order_item_adjustment" (
    "id"                          UUID NOT NULL DEFAULT gen_random_uuid(),
    "order_item_id"               UUID NOT NULL,
    "amount"                      DECIMAL(12, 2) NOT NULL,
    "reason"                      "OrderItemAdjustmentReason",
    "requested_by_user_id"        UUID,
    "kitchen_ticket_item_event_id" UUID,
    "created_at"                  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "order_item_adjustment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_order_item_adjustment_order_item"
    ON "order_item_adjustment"("order_item_id");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_order_item_adjustment_order_item'
    ) THEN
        ALTER TABLE "order_item_adjustment"
            ADD CONSTRAINT "fk_order_item_adjustment_order_item"
            FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_order_item_adjustment_requested_by'
    ) THEN
        ALTER TABLE "order_item_adjustment"
            ADD CONSTRAINT "fk_order_item_adjustment_requested_by"
            FOREIGN KEY ("requested_by_user_id") REFERENCES "business_user"("id")
            ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_order_item_adjustment_ticket_event'
    ) THEN
        ALTER TABLE "order_item_adjustment"
            ADD CONSTRAINT "fk_order_item_adjustment_ticket_event"
            FOREIGN KEY ("kitchen_ticket_item_event_id") REFERENCES "kitchen_ticket_item_event"("id")
            ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;
END $$;

COMMIT;
