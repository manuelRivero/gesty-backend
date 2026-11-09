-- Fase 2 de docs/arquitectura/POS_TECHNICAL_DESIGN.md: apertura/transferencia/cierre físico
-- de cuenta de salón sobre una mesa. No toca `orders` (eso es Fase 3: `orders.table_tab_id`
-- llega en una migración posterior) ni ninguna tabla de pagos/cocina/facturación.
--
-- NOTA DE PROCESO (igual a la ya documentada en 20261013220000_add_checkout_attempt):
-- este archivo se escribió a mano, siguiendo la convención de nombres y estilo de
-- Prisma Migrate, y NO SE EJECUTÓ contra ninguna base de datos real. Antes de aplicarlo:
--   1. Verificar que `prisma/schema.prisma` de este repo es efectivamente la fuente de
--      verdad a migrar, y no algo que el script `prisma:sync` (package.json) vaya a
--      sobrescribir desde `../food-service-backend/prisma/schema.prisma` antes del deploy
--      — si ese repo hermano es la fuente real, los mismos modelos deben replicarse ahí.
--   2. Confirmar contra qué base corre (ver `SABROSON_POS_AUDIT.md §2`: `.env` de este
--      repo tiene múltiples `DATABASE_URL` sin comentar apuntando a destinos distintos).
--   3. No hay paso de `prisma migrate deploy`/`db push` automatizado en este repo — aplicar
--      manualmente, igual que el resto de `prisma/migrations/*` existente.
--
-- IDEMPOTENCIA: `IF NOT EXISTS` / chequeo manual de constraint, dentro de una única
-- transacción — correrlo dos veces seguidas es un no-op, y un corte a mitad de camino
-- hace ROLLBACK completo.

BEGIN;

DO $$ BEGIN
  CREATE TYPE "TableTabStatus" AS ENUM ('open', 'closed', 'merged');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "table_tab" (
    "id"                UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id"       UUID NOT NULL,
    "status"            "TableTabStatus" NOT NULL DEFAULT 'open',
    "opened_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "closed_at"         TIMESTAMPTZ(6),
    "opened_by_user_id" UUID,
    "assigned_user_id"  UUID,

    CONSTRAINT "table_tab_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "table_tab_table" (
    "id"            UUID NOT NULL DEFAULT gen_random_uuid(),
    "table_tab_id"  UUID NOT NULL,
    "table_id"      UUID NOT NULL,
    "assigned_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "unassigned_at" TIMESTAMPTZ(6),

    CONSTRAINT "table_tab_table_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_table_tab_business"
    ON "table_tab"("business_id");

CREATE INDEX IF NOT EXISTS "idx_table_tab_business_status"
    ON "table_tab"("business_id", "status");

CREATE INDEX IF NOT EXISTS "idx_table_tab_table_tab"
    ON "table_tab_table"("table_tab_id");

CREATE INDEX IF NOT EXISTS "idx_table_tab_table_table"
    ON "table_tab_table"("table_id");

-- Garantía dura del invariante central de §4.A: a lo sumo UNA asignación ACTIVA
-- (unassigned_at IS NULL) por mesa, sin importar cuántas table_tab/filas históricas
-- existan. No expresable en el DSL declarativo de Prisma (índice único parcial) —
-- es la única fuente real de esta garantía, el advisory lock del servicio solo evita
-- la ventana de carrera al decidir si abrir una fila nueva, nunca sustituye este índice.
CREATE UNIQUE INDEX IF NOT EXISTS "unique_table_tab_table_active_assignment"
    ON "table_tab_table"("table_id")
    WHERE ("unassigned_at" IS NULL);

-- Postgres no soporta `ADD CONSTRAINT IF NOT EXISTS`; se chequea a mano, igual que
-- en el resto de prisma/migrations/*.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_table_tab_business'
    ) THEN
        ALTER TABLE "table_tab"
            ADD CONSTRAINT "fk_table_tab_business"
            FOREIGN KEY ("business_id") REFERENCES "business"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_table_tab_opened_by'
    ) THEN
        ALTER TABLE "table_tab"
            ADD CONSTRAINT "fk_table_tab_opened_by"
            FOREIGN KEY ("opened_by_user_id") REFERENCES "business_user"("id")
            ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_table_tab_assigned_to'
    ) THEN
        ALTER TABLE "table_tab"
            ADD CONSTRAINT "fk_table_tab_assigned_to"
            FOREIGN KEY ("assigned_user_id") REFERENCES "business_user"("id")
            ON DELETE SET NULL ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_table_tab_table_tab_tab'
    ) THEN
        ALTER TABLE "table_tab_table"
            ADD CONSTRAINT "fk_table_tab_table_tab_tab"
            FOREIGN KEY ("table_tab_id") REFERENCES "table_tab"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_table_tab_table_table'
    ) THEN
        ALTER TABLE "table_tab_table"
            ADD CONSTRAINT "fk_table_tab_table_table"
            FOREIGN KEY ("table_id") REFERENCES "table"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

COMMIT;
