-- Reserva de intento de Checkout para evitar más de una Checkout Session /
-- suscripción nueva en curso por negocio. No modifica ninguna tabla ni dato
-- existente (subscription, business, plan, stripe_webhook_event quedan
-- intactas).
--
-- NOTA DE PROCESO: este repositorio no tenía historial de Prisma Migrate
-- (no existía prisma/migrations/) al momento de escribir este archivo —
-- el esquema se gestionaba vía `prisma:sync` desde un repo hermano que no
-- está disponible en este filesystem. Este archivo se escribió a mano,
-- siguiendo la convención de nombres de Prisma Migrate, en vez de generarse
-- con `prisma migrate dev` (que habría requerido una base de sombra y un
-- diff contra cero historial previo frente a ~30 tablas ya existentes —
-- riesgo no aceptable sin supervisión). NO SE EJECUTÓ contra ninguna base
-- de datos real.
--
-- IDEMPOTENCIA: todo el script usa `IF NOT EXISTS` (o un chequeo
-- equivalente para la FK, que Postgres no soporta con esa cláusula) y
-- corre dentro de una única transacción, para que:
--   (a) si se corta a mitad de camino, Postgres hace ROLLBACK completo en
--       vez de dejar la tabla a medio crear;
--   (b) correrlo dos veces seguidas no falle ni duplique nada — queda en
--       el mismo estado final.
-- Antes de aplicarlo, verificar con:
--   SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'checkout_attempt');
-- Si ya existe, este script es seguro de re-ejecutar igual (no-op), pero
-- de todos modos no hace falta.
--
-- APLICACIÓN: no hay ningún paso de migración automatizado en el pipeline
-- de despliegue de este repo (ni `render.yaml` ni `docker-compose.prod.yml`
-- ejecutan `prisma migrate deploy` ni `db push`) — ver la entrega de la
-- revisión para el procedimiento manual recomendado y por qué NO conviene
-- adoptar `prisma migrate deploy` todavía sobre esta base (no tiene
-- historial de Prisma Migrate para el resto del esquema existente, y crear
-- ese baseline es una decisión del equipo, no algo que deba inventarse acá).

BEGIN;

CREATE TABLE IF NOT EXISTS "checkout_attempt" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "plan_code" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stripe_checkout_session_id" TEXT,
    "stripe_customer_id" TEXT,
    "session_url" TEXT,
    "session_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "checkout_attempt_pkey" PRIMARY KEY ("id")
);

-- Un mismo stripe_checkout_session_id nunca pertenece a dos intentos.
CREATE UNIQUE INDEX IF NOT EXISTS "checkout_attempt_stripe_checkout_session_id_key"
    ON "checkout_attempt"("stripe_checkout_session_id");

CREATE INDEX IF NOT EXISTS "idx_checkout_attempt_business_id"
    ON "checkout_attempt"("business_id");

CREATE INDEX IF NOT EXISTS "idx_checkout_attempt_status_created_at"
    ON "checkout_attempt"("status", "created_at");

-- Garantía de exclusión real: como máximo UN intento vigente
-- (pending/created/unresolved) por negocio. Esta es la autoridad final,
-- independiente del advisory lock o del mutex en memoria de la aplicación.
CREATE UNIQUE INDEX IF NOT EXISTS "unique_business_pending_checkout_attempt"
    ON "checkout_attempt"("business_id")
    WHERE (status = ANY (ARRAY['pending'::text,'created'::text,'unresolved'::text]));

-- Postgres no soporta `ADD CONSTRAINT IF NOT EXISTS`; se chequea a mano.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'fk_checkout_attempt_business'
    ) THEN
        ALTER TABLE "checkout_attempt"
            ADD CONSTRAINT "fk_checkout_attempt_business"
            FOREIGN KEY ("business_id") REFERENCES "business"("id")
            ON DELETE CASCADE ON UPDATE NO ACTION;
    END IF;
END $$;

COMMIT;
