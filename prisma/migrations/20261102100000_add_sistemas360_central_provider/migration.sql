-- Soporte para Sistemas 360 como proveedor de facturación con cuenta CENTRAL (token de cuenta,
-- múltiples emisores) — ver `services/invoicing/providers/sistemas360*` y
-- `services/invoicing/centralProviderConfig.service.ts`.
--
-- ADITIVA: no borra ni modifica ningún dato de TusFacturas. `fiscal_provider_credential` (por
-- negocio) sigue existiendo intacto para ese proveedor.
--
-- NOTA DE PROCESO: igual que las migraciones anteriores de este repositorio, este archivo se
-- escribió a mano siguiendo la convención de nombres de Prisma Migrate y NO SE EJECUTÓ contra
-- ninguna base de datos real. Aplicar manualmente (psql) y luego correr `npx prisma generate`.

BEGIN;

-- `ALTER TYPE ... ADD VALUE` es transaccional desde Postgres 12; no se usa el valor nuevo dentro
-- de esta misma transacción (no hace falta, es solo DDL).
ALTER TYPE "FiscalInvoiceStatus" ADD VALUE IF NOT EXISTS 'simulated';

CREATE TABLE IF NOT EXISTS "invoicing_central_provider_config" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "provider" TEXT NOT NULL,
    "active_environment" TEXT NOT NULL DEFAULT 'sandbox',
    "sandbox_token_encrypted" TEXT,
    "production_token_encrypted" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "status" "FiscalConfigStatus" NOT NULL DEFAULT 'not_configured',
    "last_validated_at" TIMESTAMPTZ(6),
    "last_validation_detail" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "invoicing_central_provider_config_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoicing_central_provider_config_provider_key" UNIQUE ("provider")
);
CREATE INDEX IF NOT EXISTS "idx_invoicing_central_provider_config_provider" ON "invoicing_central_provider_config"("provider");

COMMIT;
