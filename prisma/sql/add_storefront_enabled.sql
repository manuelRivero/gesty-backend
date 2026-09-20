-- Canal storefront (PLAN-ACCION-STOREFRONT-CANAL.md, BE-15).
-- Un flag prende vitrina + pedidos web.
-- Default true (incluido en todos los planes; admin kill switch). Ver también
-- storefront_enabled_default_true.sql si esta columna ya existía con DEFAULT false.
-- Ejecutar manualmente en Postgres (este repo no migra al arrancar).

ALTER TABLE business_config
  ADD COLUMN IF NOT EXISTS storefront_enabled BOOLEAN NOT NULL DEFAULT true;

-- Locales que ya tenían slug público (ORD-10 en prod) → canal on (idempotente).
UPDATE business_config bc
SET storefront_enabled = true
FROM business b
WHERE b.id = bc.business_id
  AND b.slug IS NOT NULL
  AND b.slug <> '';
