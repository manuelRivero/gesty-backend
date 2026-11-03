-- Cierre de aceptación de la integración Sistemas 360: instrumentación real de requests,
-- aislamiento de entorno por comprobante y huella de validación por entorno.
--
-- ADITIVA: solo agrega columnas nullable o con DEFAULT. No toca TusFacturas ni borra nada.
--
-- NOTA DE PROCESO: igual que las migraciones anteriores de este repositorio, este archivo se
-- escribió a mano siguiendo la convención de nombres de Prisma Migrate y NO SE EJECUTÓ contra
-- ninguna base de datos real. Aplicar manualmente (psql) y luego correr `npx prisma generate`.
--
-- TRATAMIENTO DE REGISTROS HISTÓRICOS:
-- - `fiscal_invoice.provider_environment`: queda NULL para toda fila existente (TusFacturas y
--   Sistemas 360 emitidas antes de esta migración). No se infiere ni se backfillea — no hay
--   evidencia suficiente de en qué entorno se emitió cada una. El código trata NULL como "usar
--   el entorno activo actual", igual que el comportamiento de antes de este cambio.
-- - `invoicing_central_provider_config.total_requests_count`: arranca en 0. No representa el
--   consumo histórico real (no medido hasta ahora), solo el consumo a partir de este despliegue.
-- - `invoicing_central_provider_config.last_validated_environment`: NULL hasta la próxima
--   validación explícita — una fila con `status = 'validated'` de antes de esta migración deja
--   de habilitar la activación de producción hasta validarse de nuevo (conservador, a propósito).

BEGIN;

ALTER TABLE "fiscal_invoice"
    ADD COLUMN IF NOT EXISTS "provider_environment" TEXT;

ALTER TABLE "invoicing_central_provider_config"
    ADD COLUMN IF NOT EXISTS "last_validated_environment" TEXT,
    ADD COLUMN IF NOT EXISTS "total_requests_count" INTEGER NOT NULL DEFAULT 0;

COMMIT;
