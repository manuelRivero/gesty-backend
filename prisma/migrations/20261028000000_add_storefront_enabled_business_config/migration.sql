-- Agrega storefront_enabled a business_config: control operativo del canal
-- web (vitrina + pedidos storefront), independiente de bot_enabled. Ya
-- estaba en schema.prisma pero nunca se aplicó contra la base real, lo que
-- causaba P2022 (ColumnNotFound) en listPublicStorefronts.
--
-- NOTA DE PROCESO: igual que las migraciones anteriores, este repositorio
-- no tiene pipeline automatizado de `prisma migrate deploy` / `db push`.
-- Este archivo se escribió a mano siguiendo la convención de nombres de
-- Prisma Migrate y NO SE EJECUTÓ contra ninguna base de datos real —
-- aplicar manualmente (psql) y luego correr `npx prisma generate` para
-- regenerar el client con el campo nuevo.
--
-- IDEMPOTENCIA: usa `ADD COLUMN IF NOT EXISTS` y corre en una única
-- transacción; es seguro re-ejecutarlo.

BEGIN;

ALTER TABLE "business_config"
    ADD COLUMN IF NOT EXISTS "storefront_enabled" BOOLEAN NOT NULL DEFAULT true;

COMMIT;
