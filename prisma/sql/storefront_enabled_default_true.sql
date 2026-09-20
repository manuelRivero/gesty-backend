-- BE-15: storefront incluido en todos los planes (sin SKU aparte / BILL-06 cancelado).
-- Default opt-out: true; el admin apaga con storefront_enabled=false.
-- Ejecutar en Postgres si ya corriste add_storefront_enabled.sql (DEFAULT false).

ALTER TABLE business_config
  ALTER COLUMN storefront_enabled SET DEFAULT true;
