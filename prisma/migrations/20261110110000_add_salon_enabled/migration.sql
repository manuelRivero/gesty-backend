-- Fase 8.1 (frontend gesty-admin, docs/arquitectura/POS_TECHNICAL_DESIGN.md
-- §4.A): kill switch del módulo de salón, mismo patrón que el resto de
-- booleans de `business_config` (orders_enabled, takeaway_enabled, etc.).
-- Default false: protege a los locales que no operan salón — no deben ver
-- ningún acceso al POS/KDS en el panel admin hasta que se active a propósito.
--
-- NOTA DE PROCESO (misma convención que las migraciones de Fase 2-7 previas):
-- escrito a mano, sin `prisma migrate deploy` automatizado en este repo.
--
-- IDEMPOTENCIA: `IF NOT EXISTS`, dentro de una única transacción.

BEGIN;

ALTER TABLE "business_config" ADD COLUMN IF NOT EXISTS "salon_enabled" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
