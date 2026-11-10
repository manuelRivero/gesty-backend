-- `COCINA` se agregó a `BUSINESS_USER_ROLES` (src/types/auth.ts) como rol
-- independiente de `MOZO` — mozo opera la mesa (/pos), cocina opera las
-- comandas (/kds). El CHECK constraint de `business_user.role` a nivel de
-- base de datos no se había actualizado. Esta migración lo corrige, siguiendo
-- el mismo patrón que `20261110180000_add_mozo_role_check`.
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
    CHECK (role = ANY (ARRAY['OWNER'::text, 'ADMIN'::text, 'STAFF'::text, 'DELIVERY'::text, 'SUPER_ADMIN'::text, 'MOZO'::text, 'COCINA'::text]));
END $$;

COMMIT;
