-- Los IDs son únicos por entorno. Las asociaciones sin entorno conocido tienen
-- unicidad propia y no pueden colisionar con una asociación de entorno conocido.

BEGIN;

ALTER TABLE public.fiscal_configuration
  ADD COLUMN external_issuer_environment TEXT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.fiscal_configuration
    WHERE external_issuer_id IS NOT NULL
    GROUP BY external_issuer_environment, external_issuer_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'fiscal_configuration contiene external_issuer_id duplicados dentro del mismo entorno; inspeccionarlos antes de crear los índices únicos';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.fiscal_configuration
    WHERE external_issuer_id IS NOT NULL
    GROUP BY external_issuer_id
    HAVING BOOL_OR(external_issuer_environment IS NULL) AND COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION
      'fiscal_configuration contiene external_issuer_id duplicados entre entorno NULL y conocido; inspeccionarlos antes de crear los índices únicos';
  END IF;
END $$;

CREATE UNIQUE INDEX unique_fiscal_configuration_issuer_environment_id
  ON public.fiscal_configuration (external_issuer_environment, external_issuer_id)
  WHERE external_issuer_environment IS NOT NULL
    AND external_issuer_id IS NOT NULL;

CREATE UNIQUE INDEX unique_fiscal_configuration_issuer_id_without_environment
  ON public.fiscal_configuration (external_issuer_id)
  WHERE external_issuer_environment IS NULL
    AND external_issuer_id IS NOT NULL;

-- Prisma no puede expresar estas dos restricciones parciales cruzadas. Evitan
-- que una fila legacy con entorno NULL comparta ID con sandbox o producción,
-- a la vez que permiten que sandbox y producción compartan el mismo ID.
CREATE UNIQUE INDEX unique_fiscal_configuration_issuer_id_except_production
  ON public.fiscal_configuration (external_issuer_id)
  WHERE external_issuer_id IS NOT NULL
    AND (external_issuer_environment IS NULL OR external_issuer_environment <> 'production');

CREATE UNIQUE INDEX unique_fiscal_configuration_issuer_id_except_sandbox
  ON public.fiscal_configuration (external_issuer_id)
  WHERE external_issuer_id IS NOT NULL
    AND (external_issuer_environment IS NULL OR external_issuer_environment <> 'sandbox');

COMMIT;
