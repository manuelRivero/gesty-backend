-- Agrega el flag external_delivery_enabled a business_config.
-- Cuando está en true, el agente de WhatsApp no envía el QR del pedido
-- (el rider del servicio externo no tiene acceso a la app).
-- El fee de delivery sigue resolviéndose por las zonas propias del local.
-- Ejecutar manualmente en Postgres (este repo no migra al arrancar).

ALTER TABLE business_config
  ADD COLUMN IF NOT EXISTS external_delivery_enabled boolean NOT NULL DEFAULT false;
