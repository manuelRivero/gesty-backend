-- Agrega entitlements comerciales a plan: ai_enabled (habilita IA
-- conversacional) y shopping_enabled (habilita acceso público a
-- Shopping/storefront). Ya estaban en schema.prisma pero nunca se
-- aplicaron contra la base real, lo que causaba P2022 (ColumnNotFound)
-- en listPublicStorefronts.
--
-- NOTA DE PROCESO: igual que las migraciones anteriores, este repositorio
-- no tiene pipeline automatizado de `prisma migrate deploy` / `db push`.
-- Este archivo se escribió a mano siguiendo la convención de nombres de
-- Prisma Migrate y NO SE EJECUTÓ contra ninguna base de datos real —
-- aplicar manualmente (psql) y luego correr `npx prisma generate` para
-- regenerar el client con los campos nuevos.
--
-- IDEMPOTENCIA: usa `ADD COLUMN IF NOT EXISTS` y corre en una única
-- transacción; es seguro re-ejecutarlo.

BEGIN;

ALTER TABLE "plan"
    ADD COLUMN IF NOT EXISTS "ai_enabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS "shopping_enabled" BOOLEAN NOT NULL DEFAULT true;

COMMIT;
