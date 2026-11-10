-- Medio de cobro en el ledger de salón (POS_TECHNICAL_DESIGN.md §4.D,
-- ampliación posterior a Fase 6: el cajero puede partir un cobro entre
-- efectivo/tarjeta/transferencia/QR — cada medio es una fila `tab_payment`
-- propia, nunca varios montos en una sola fila).
--
-- NOTA DE PROCESO: escrito a mano, sin `prisma migrate deploy` automatizado
-- en este repo. Aplicar manualmente contra la base de desarrollo confirmada,
-- nunca contra staging/producción.
--
-- IDEMPOTENCIA: `IF NOT EXISTS`, dentro de una única transacción. No hay
-- filas existentes en `tab_payment` en la base de desarrollo al momento de
-- escribir esta migración (verificado), así que el default `'cash'` es solo
-- para no romper si algo cambia antes de aplicarla, no un backfill real.

BEGIN;

DO $$ BEGIN
  CREATE TYPE "TabPaymentMethod" AS ENUM ('cash', 'card', 'transfer', 'qr');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "tab_payment"
  ADD COLUMN IF NOT EXISTS "payment_method" "TabPaymentMethod" NOT NULL DEFAULT 'cash';

COMMIT;
