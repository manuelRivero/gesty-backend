-- Extiende payment_method_config para usarlo como aceptación de métodos por local
-- (además de recargos/descuentos): instructions (CBU/alias) y sort_order.
-- Ejecutar manualmente en Postgres (este repo no migra al arrancar).

ALTER TABLE payment_method_config
  ADD COLUMN IF NOT EXISTS instructions text,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
