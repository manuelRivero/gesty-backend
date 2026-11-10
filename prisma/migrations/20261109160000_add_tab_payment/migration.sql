-- Fase 6 de docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.D: ledger de pagos de
-- cuenta de salón (`tab_payment`/`tab_payment_application`). El saldo de una
-- cuenta/orden se calcula SIEMPRE por agregación sobre esta tabla + los
-- adjustments de order_item_adjustment (Fase 4) — nunca un campo cacheado.
--
-- NOTA DE PROCESO (misma convención que las migraciones de Fase 2-5 previas):
-- escrito a mano, sin `prisma migrate deploy` automatizado en este repo. Este
-- repo es la única fuente de verdad del esquema — aplicar manualmente contra
-- la base de desarrollo confirmada, nunca contra staging/producción.
--
-- IDEMPOTENCIA: `IF NOT EXISTS` / chequeo manual de constraint, dentro de una
-- única transacción — correrlo dos veces seguidas es un no-op, y un corte a
-- mitad de camino hace ROLLBACK completo.

BEGIN;

DO $$ BEGIN
  CREATE TYPE "TabPaymentStatus" AS ENUM ('pending', 'confirmed', 'reversed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "tab_payment" (
    "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id"        UUID NOT NULL,
    "table_tab_id"       UUID NOT NULL,
    "amount_tendered"    DECIMAL(12, 2) NOT NULL,
    "amount_applied"     DECIMAL(12, 2) NOT NULL,
    "status"             "TabPaymentStatus" NOT NULL DEFAULT 'confirmed',
    "reversal_of_id"     UUID,
    "idempotency_key"    TEXT,
    "created_by_user_id" UUID,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "tab_payment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "tab_payment_application" (
    "id"             UUID NOT NULL DEFAULT gen_random_uuid(),
    "tab_payment_id" UUID NOT NULL,
    "order_id"       UUID NOT NULL,
    "amount"         DECIMAL(12, 2) NOT NULL,
    "created_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "tab_payment_application_pkey" PRIMARY KEY ("id")
);

-- Índices --------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS "idx_tab_payment_table_tab"
    ON "tab_payment"("table_tab_id");

CREATE INDEX IF NOT EXISTS "idx_tab_payment_business_status"
    ON "tab_payment"("business_id", "status");

-- Único por negocio solo cuando se provee (reintentos seguros desde el
-- cliente) — índice único parcial, no expresable en el DSL declarativo de
-- Prisma, mismo patrón ya usado por `unique_table_tab_table_active_assignment`.
CREATE UNIQUE INDEX IF NOT EXISTS "unique_tab_payment_idempotency_key"
    ON "tab_payment"("business_id", "idempotency_key")
    WHERE ("idempotency_key" IS NOT NULL);

CREATE INDEX IF NOT EXISTS "idx_tab_payment_application_payment"
    ON "tab_payment_application"("tab_payment_id");

CREATE INDEX IF NOT EXISTS "idx_tab_payment_application_order"
    ON "tab_payment_application"("order_id");

-- Foreign keys -----------------------------------------------------------------
-- Postgres no soporta `ADD CONSTRAINT IF NOT EXISTS`; se chequea a mano, igual
-- que en el resto de prisma/migrations/*.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_tab_payment_business'
    ) THEN
        ALTER TABLE "tab_payment"
            ADD CONSTRAINT "fk_tab_payment_business"
            FOREIGN KEY ("business_id") REFERENCES "business"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_tab_payment_table_tab'
    ) THEN
        ALTER TABLE "tab_payment"
            ADD CONSTRAINT "fk_tab_payment_table_tab"
            FOREIGN KEY ("table_tab_id") REFERENCES "table_tab"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_tab_payment_reversal_of'
    ) THEN
        ALTER TABLE "tab_payment"
            ADD CONSTRAINT "fk_tab_payment_reversal_of"
            FOREIGN KEY ("reversal_of_id") REFERENCES "tab_payment"("id")
            ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_tab_payment_created_by'
    ) THEN
        ALTER TABLE "tab_payment"
            ADD CONSTRAINT "fk_tab_payment_created_by"
            FOREIGN KEY ("created_by_user_id") REFERENCES "business_user"("id")
            ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_tab_payment_application_payment'
    ) THEN
        ALTER TABLE "tab_payment_application"
            ADD CONSTRAINT "fk_tab_payment_application_payment"
            FOREIGN KEY ("tab_payment_id") REFERENCES "tab_payment"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_tab_payment_application_order'
    ) THEN
        ALTER TABLE "tab_payment_application"
            ADD CONSTRAINT "fk_tab_payment_application_order"
            FOREIGN KEY ("order_id") REFERENCES "orders"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

COMMIT;
