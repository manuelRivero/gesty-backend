-- Web Push de seguimiento storefront (ORD-13).
-- Ejecutar manualmente en Postgres (este repo no migra al arrancar).

CREATE TABLE IF NOT EXISTS storefront_order_push_subscription (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES business(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  VARCHAR(512),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT storefront_order_push_subscription_endpoint_key UNIQUE (endpoint)
);

CREATE INDEX IF NOT EXISTS idx_storefront_push_order
  ON storefront_order_push_subscription (order_id);

CREATE INDEX IF NOT EXISTS idx_storefront_push_business
  ON storefront_order_push_subscription (business_id);
