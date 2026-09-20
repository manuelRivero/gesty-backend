-- Defaults limpios de capacidades (PLAN-ACCION-CAPABILITIES-BOOTSTRAP.md, D1).
-- Solo cambia DEFAULT de columna; no hace UPDATE masivo de filas existentes (D9).
-- Ejecutar manualmente en Postgres (este repo no migra al arrancar).

ALTER TABLE business_config
  ALTER COLUMN orders_enabled SET DEFAULT false,
  ALTER COLUMN checkout_enabled SET DEFAULT false,
  ALTER COLUMN reservations_enabled SET DEFAULT false,
  ALTER COLUMN delivery_enabled SET DEFAULT false,
  ALTER COLUMN takeaway_enabled SET DEFAULT false;
