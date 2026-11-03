-- Módulo de facturación electrónica (add-on comercial, desacoplado de proveedor).
--
-- NOTA DE PROCESO: igual que las migraciones anteriores de este repositorio, este
-- archivo se escribió a mano siguiendo la convención de nombres de Prisma Migrate y
-- NO SE EJECUTÓ contra ninguna base de datos real. Aplicar manualmente (psql) contra
-- cada entorno y luego correr `npx prisma generate`.
--
-- IDEMPOTENCIA: usa `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` y corre en
-- una única transacción; es seguro re-ejecutarlo.

BEGIN;

DO $$ BEGIN
  CREATE TYPE "FiscalConfigStatus" AS ENUM ('not_configured', 'pending_validation', 'validated', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FiscalVoucherType" AS ENUM ('A', 'B', 'C');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FiscalInvoiceKind" AS ENUM ('invoice', 'credit_note');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "FiscalInvoiceStatus" AS ENUM ('pending', 'processing', 'authorized', 'rejected', 'failed', 'requires_review', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "fiscal_configuration" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'tusfacturas',
    "cuit" TEXT,
    "razon_social" TEXT,
    "condicion_iva" TEXT,
    "domicilio_fiscal" TEXT,
    "punto_venta" INTEGER,
    "auto_issue_online" BOOLEAN NOT NULL DEFAULT true,
    "auto_issue_cash" BOOLEAN NOT NULL DEFAULT false,
    "status" "FiscalConfigStatus" NOT NULL DEFAULT 'not_configured',
    "validated_at" TIMESTAMPTZ(6),
    "external_issuer_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "fiscal_configuration_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fiscal_configuration_business_id_key" UNIQUE ("business_id"),
    CONSTRAINT "fiscal_configuration_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_fiscal_configuration_business" ON "fiscal_configuration"("business_id");

CREATE TABLE IF NOT EXISTS "fiscal_provider_credential" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "credentials_encrypted" TEXT NOT NULL,
    "is_sandbox" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "fiscal_provider_credential_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fiscal_provider_credential_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS "fiscal_provider_credential_business_id_provider_key" ON "fiscal_provider_credential"("business_id", "provider");
CREATE INDEX IF NOT EXISTS "idx_fiscal_provider_credential_business" ON "fiscal_provider_credential"("business_id");

CREATE TABLE IF NOT EXISTS "fiscal_invoice" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "kind" "FiscalInvoiceKind" NOT NULL DEFAULT 'invoice',
    "provider" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "provider_invoice_id" TEXT,
    "voucher_type" "FiscalVoucherType",
    "punto_venta" INTEGER,
    "comprobante_numero" INTEGER,
    "cae" TEXT,
    "cae_vencimiento" TIMESTAMPTZ(6),
    "issued_at" TIMESTAMPTZ(6),
    "amount" DECIMAL(12,2) NOT NULL,
    "currency_code" CHAR(3) NOT NULL,
    "status" "FiscalInvoiceStatus" NOT NULL DEFAULT 'pending',
    "pdf_url" TEXT,
    "provider_response" JSONB,
    "error_message" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "fiscal_invoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "fiscal_invoice_idempotency_key_key" UNIQUE ("idempotency_key"),
    CONSTRAINT "fiscal_invoice_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
    CONSTRAINT "fiscal_invoice_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_fiscal_invoice_business_order_kind" ON "fiscal_invoice"("business_id", "order_id", "kind");
CREATE INDEX IF NOT EXISTS "idx_fiscal_invoice_business_status" ON "fiscal_invoice"("business_id", "status");
CREATE INDEX IF NOT EXISTS "idx_fiscal_invoice_business_order" ON "fiscal_invoice"("business_id", "order_id");

CREATE TABLE IF NOT EXISTS "invoicing_addon" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "monthly_voucher_limit" INTEGER,
    "price_per_voucher" DECIMAL(10,4),
    "provider_cost_per_voucher" DECIMAL(10,4),
    "currency_code" CHAR(3) NOT NULL DEFAULT 'USD',
    "activated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "invoicing_addon_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoicing_addon_business_id_key" UNIQUE ("business_id"),
    CONSTRAINT "invoicing_addon_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX IF NOT EXISTS "idx_invoicing_addon_business" ON "invoicing_addon"("business_id");

CREATE TABLE IF NOT EXISTS "invoicing_usage_period" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "business_id" UUID NOT NULL,
    "period" TEXT NOT NULL,
    "vouchers_authorized" INTEGER NOT NULL DEFAULT 0,
    "provider_requests" INTEGER NOT NULL DEFAULT 0,
    "provider_cost_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "commercial_amount_total" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency_code" CHAR(3) NOT NULL,
    "reconciliation_status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    CONSTRAINT "invoicing_usage_period_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "invoicing_usage_period_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS "unique_invoicing_usage_period" ON "invoicing_usage_period"("business_id", "period");

COMMIT;
