-- Fase 7 de docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.E: facturación
-- consolidada del consumo de salón. Crea `billable_charge`/`billable_charge_line`
-- (tracking de cantidad ya facturada por order_item, para prevenir doble
-- facturación parcial — DECISIÓN APROBADA), y generaliza `fiscal_invoice` para
-- que una factura pueda colgar de un `billable_charge` en vez de una `orders`
-- individual (flujo e-commerce existente sin cambios: sigue usando `order_id`).
--
-- NOTA DE PROCESO (misma convención que las migraciones de Fase 2-6 previas):
-- escrito a mano, sin `prisma migrate deploy` automatizado en este repo. Este
-- repo es la única fuente de verdad del esquema — aplicar manualmente contra
-- la base de desarrollo confirmada, nunca contra staging/producción.
--
-- IDEMPOTENCIA: `IF NOT EXISTS` / chequeo manual de constraint, dentro de una
-- única transacción — correrlo dos veces seguidas es un no-op, y un corte a
-- mitad de camino hace ROLLBACK completo.

BEGIN;

DO $$ BEGIN
  CREATE TYPE "BillableChargeStatus" AS ENUM ('open', 'issued');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "billable_charge" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "table_tab_id" UUID NOT NULL,
    "amount"      DECIMAL(12, 2) NOT NULL,
    "status"      "BillableChargeStatus" NOT NULL DEFAULT 'open',
    "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "billable_charge_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "billable_charge_line" (
    "id"                 UUID NOT NULL DEFAULT gen_random_uuid(),
    "billable_charge_id" UUID NOT NULL,
    "order_item_id"      UUID NOT NULL,
    "quantity_billed"    INTEGER NOT NULL,
    "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "billable_charge_line_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_billable_charge_table_tab"
    ON "billable_charge"("table_tab_id");

CREATE INDEX IF NOT EXISTS "idx_billable_charge_business_status"
    ON "billable_charge"("business_id", "status");

CREATE INDEX IF NOT EXISTS "idx_billable_charge_line_charge"
    ON "billable_charge_line"("billable_charge_id");

CREATE INDEX IF NOT EXISTS "idx_billable_charge_line_order_item"
    ON "billable_charge_line"("order_item_id");

-- fiscal_invoice: generalización para colgar de un billable_charge en vez de
-- (o además de, nunca ambos) una orders individual -------------------------

ALTER TABLE "fiscal_invoice" ALTER COLUMN "order_id" DROP NOT NULL;
ALTER TABLE "fiscal_invoice" ADD COLUMN IF NOT EXISTS "billable_charge_id" UUID;

-- order_id/billable_charge_id son mutuamente excluyentes y uno de los dos es
-- siempre requerido (§4.E) — nunca ambos NULL, nunca ambos presentes.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_fiscal_invoice_order_xor_billable_charge'
    ) THEN
        ALTER TABLE "fiscal_invoice"
            ADD CONSTRAINT "check_fiscal_invoice_order_xor_billable_charge"
            CHECK (
                (("order_id" IS NOT NULL) AND ("billable_charge_id" IS NULL))
                OR
                (("order_id" IS NULL) AND ("billable_charge_id" IS NOT NULL))
            );
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_fiscal_invoice_business_billable_charge"
    ON "fiscal_invoice"("business_id", "billable_charge_id");

-- Idempotencia de emisión por billable_charge, paralela a la ya existente
-- por order_id (unique_fiscal_invoice_business_order_kind).
CREATE UNIQUE INDEX IF NOT EXISTS "unique_fiscal_invoice_business_billable_charge_kind"
    ON "fiscal_invoice"("business_id", "billable_charge_id", "kind")
    WHERE ("billable_charge_id" IS NOT NULL);

-- Foreign keys -----------------------------------------------------------------
-- Postgres no soporta `ADD CONSTRAINT IF NOT EXISTS`; se chequea a mano, igual
-- que en el resto de prisma/migrations/*.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_billable_charge_business'
    ) THEN
        ALTER TABLE "billable_charge"
            ADD CONSTRAINT "fk_billable_charge_business"
            FOREIGN KEY ("business_id") REFERENCES "business"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_billable_charge_table_tab'
    ) THEN
        ALTER TABLE "billable_charge"
            ADD CONSTRAINT "fk_billable_charge_table_tab"
            FOREIGN KEY ("table_tab_id") REFERENCES "table_tab"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_billable_charge_line_charge'
    ) THEN
        ALTER TABLE "billable_charge_line"
            ADD CONSTRAINT "fk_billable_charge_line_charge"
            FOREIGN KEY ("billable_charge_id") REFERENCES "billable_charge"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_billable_charge_line_order_item'
    ) THEN
        ALTER TABLE "billable_charge_line"
            ADD CONSTRAINT "fk_billable_charge_line_order_item"
            FOREIGN KEY ("order_item_id") REFERENCES "order_item"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_fiscal_invoice_billable_charge'
    ) THEN
        ALTER TABLE "fiscal_invoice"
            ADD CONSTRAINT "fk_fiscal_invoice_billable_charge"
            FOREIGN KEY ("billable_charge_id") REFERENCES "billable_charge"("id")
            ON DELETE NO ACTION ON UPDATE NO ACTION;
    END IF;
END $$;

COMMIT;
