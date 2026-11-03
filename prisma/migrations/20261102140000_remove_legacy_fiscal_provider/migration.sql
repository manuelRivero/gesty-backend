-- Deja Sistemas 360 como proveedor fiscal único y elimina credenciales por negocio.
-- No borrar datos experimentales de forma implícita: si hay credenciales o comprobantes con
-- otro proveedor, la migración se detiene para que se inspeccionen antes de decidir su destino.

BEGIN;

DO $$
DECLARE
  has_credentials BOOLEAN;
  has_non_sistemas360_invoices BOOLEAN;
  has_non_sistemas360_central_config BOOLEAN;
BEGIN
  IF to_regclass('public.fiscal_provider_credential') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.fiscal_provider_credential)'
      INTO has_credentials;
    IF has_credentials THEN
      RAISE EXCEPTION
        'fiscal_provider_credential contiene datos; inspeccionarlos antes de eliminar la tabla';
    END IF;
  END IF;

  IF to_regclass('public.invoicing_central_provider_config') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.invoicing_central_provider_config WHERE provider <> ''sistemas360'')'
      INTO has_non_sistemas360_central_config;
    IF has_non_sistemas360_central_config THEN
      RAISE EXCEPTION
        'invoicing_central_provider_config contiene configuraciones ajenas a Sistemas 360; inspeccionarlas antes de continuar';
    END IF;
  END IF;

  IF to_regclass('public.fiscal_invoice') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM public.fiscal_invoice WHERE provider <> ''sistemas360'')'
      INTO has_non_sistemas360_invoices;
    IF has_non_sistemas360_invoices THEN
      RAISE EXCEPTION
        'fiscal_invoice contiene comprobantes que no son de Sistemas 360; inspeccionarlos antes de continuar';
    END IF;
  END IF;
END $$;

ALTER TABLE public.fiscal_configuration
  DROP COLUMN IF EXISTS provider;

DROP TABLE IF EXISTS public.fiscal_provider_credential;

COMMIT;
