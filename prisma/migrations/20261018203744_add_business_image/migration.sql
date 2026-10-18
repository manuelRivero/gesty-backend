-- Agrega la imagen/logo del negocio: URL pública (image_url) y key de storage
-- (image_key, para poder borrar el objeto anterior en el proveedor de storage
-- al reemplazarla). Mismo patrón que menu_item.image / menu_item.image_key.
--
-- NOTA DE PROCESO: igual que la migración anterior
-- (20261013220000_add_checkout_attempt), este repositorio no tiene pipeline
-- automatizado de `prisma migrate deploy` / `db push`. Este archivo se
-- escribió a mano siguiendo la convención de nombres de Prisma Migrate y
-- NO SE EJECUTÓ contra ninguna base de datos real — aplicar manualmente en
-- Neon (SQL editor o `psql`) y luego correr `npx prisma generate` para
-- regenerar el client con los campos nuevos.
--
-- IDEMPOTENCIA: usa `ADD COLUMN IF NOT EXISTS` y corre en una única
-- transacción; es seguro re-ejecutarlo.

BEGIN;

ALTER TABLE "business"
    ADD COLUMN IF NOT EXISTS "image_url" TEXT,
    ADD COLUMN IF NOT EXISTS "image_key" TEXT;

COMMIT;
