-- Fase 8.1 / decisión de roles de salón (POS_TECHNICAL_DESIGN.md §4.F):
-- `MOZO` se agregó a `BUSINESS_USER_ROLES` (src/types/auth.ts) pero el CHECK
-- constraint de `business_user.role` a nivel de base de datos no se había
-- actualizado — cualquier intento de crear un `business_user` con role
-- 'MOZO' violaba `business_user_role_check`. Esta migración lo corrige.
--
-- NOTA DE PROCESO: escrito a mano, sin `prisma migrate deploy` automatizado
-- en este repo. Aplicar manualmente contra la base de desarrollo confirmada,
-- nunca contra staging/producción.
--
-- IDEMPOTENCIA: chequeo manual antes de DROP/ADD, dentro de una única
-- transacción.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'business_user_role_check' AND conrelid = 'business_user'::regclass
  ) THEN
    ALTER TABLE "business_user" DROP CONSTRAINT "business_user_role_check";
  END IF;

  ALTER TABLE "business_user"
    ADD CONSTRAINT "business_user_role_check"
    CHECK (role = ANY (ARRAY['OWNER'::text, 'ADMIN'::text, 'STAFF'::text, 'DELIVERY'::text, 'SUPER_ADMIN'::text, 'MOZO'::text]));
END $$;

COMMIT;
