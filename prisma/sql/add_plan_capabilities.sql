-- Entitlements explícitos por plan (Shopping Only / separación Shopping vs IA).
-- Ver docs/planes-accion/PLAN-ACCION-SHOPPING-ONLY.md.
-- Ejecutar manualmente en Postgres (este repo no migra al arrancar).
--
-- Default true en ambas columnas: los planes existentes (basic/pro/business/
-- trial manual) conservan IA + Shopping sin ningún cambio de comportamiento.
-- `plan.code` NUNCA es el mecanismo de autorización — son estas dos columnas
-- booleanas las que `resolveBusinessCapabilities` lee.

ALTER TABLE plan
  ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE plan
  ADD COLUMN IF NOT EXISTS shopping_enabled BOOLEAN NOT NULL DEFAULT true;

-- Filas ya existentes (basic/pro/business) → explícitas, por claridad, aunque
-- el DEFAULT ya las deja en true. Idempotente.
UPDATE plan
SET ai_enabled = true, shopping_enabled = true
WHERE code IN ('basic', 'pro', 'business');

-- Alta del plan Shopping Only: Shopping sí, IA no.
-- `is_active = false` hasta que un operador configure precio real y
-- `stripe_price_id` vía `scripts/billing/sync-stripe-plans.ts` — no se
-- inventa un precio comercial acá. Ver seed-plans.ts para el upsert
-- idempotente del resto de columnas.
INSERT INTO plan (name, code, token_limit, is_active, ai_enabled, shopping_enabled, description)
VALUES (
  'Shopping Only',
  'shopping_only',
  0,
  false,
  false,
  true,
  'Tienda web (Shopping) sin asistente de IA por WhatsApp. Precio pendiente de configurar.'
)
ON CONFLICT (code) DO NOTHING;
