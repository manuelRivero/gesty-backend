-- Cache informativo de la condición de IVA registrada por el proveedor (Sistemas 360) para el
-- emisor vinculado. Nunca es la fuente de verdad para resolver el tipo de comprobante a emitir
-- (eso siempre se consulta en vivo) — solo alimenta una nota de solo lectura en el admin.
ALTER TABLE "fiscal_configuration"
  ADD COLUMN "provider_condicion_iva" TEXT,
  ADD COLUMN "provider_condicion_iva_checked_at" TIMESTAMPTZ(6);
