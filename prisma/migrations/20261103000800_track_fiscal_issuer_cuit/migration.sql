-- Registra a qué CUIT pertenece la asociación local con Sistemas 360.
-- No se hace backfill: las asociaciones anteriores no tienen correspondencia demostrable
-- y deberán volver a resolverse por CUIT antes de poder usarse en una emisión.

ALTER TABLE public.fiscal_configuration
  ADD COLUMN external_issuer_cuit TEXT;

COMMENT ON COLUMN public.fiscal_configuration.external_issuer_cuit IS
  'CUIT normalizado verificado al asociar external_issuer_id; NULL significa que la asociación requiere volver a resolverse.';
