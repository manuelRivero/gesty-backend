-- PAY-06: payment_intent puede vivir sin draft (storefront: order_id only).
-- Ejecutar manualmente en Postgres.

ALTER TABLE payment_intent
  ALTER COLUMN draft_order_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_pi_order_status
  ON payment_intent (order_id, status);
