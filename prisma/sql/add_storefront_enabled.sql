-- Canal storefront (PLAN-ACCION-STOREFRONT-CANAL.md, BE-15 / D1–D6).
-- Un flag prende vitrina + pedidos web. Default false (D5).
-- Ejecutar manualmente en Postgres (este repo no migra al arrancar).

ALTER TABLE business_config
  ADD COLUMN IF NOT EXISTS storefront_enabled BOOLEAN NOT NULL DEFAULT false;

-- D6: locales que ya tienen slug público (ORD-10 en prod) → canal on.
UPDATE business_config bc
SET storefront_enabled = true
FROM business b
WHERE b.id = bc.business_id
  AND b.slug IS NOT NULL
  AND b.slug <> '';
