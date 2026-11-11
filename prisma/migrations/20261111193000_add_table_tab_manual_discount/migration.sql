-- Descuento manual a nivel de cuenta de salon (ej. "cliente VIP"). Nunca toca
-- order_item.discount_amount (reservado para promos de WhatsApp/storefront) ni
-- orders.total_amount.
ALTER TABLE "table_tab"
  ADD COLUMN "manual_discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN "manual_discount_reason" TEXT,
  ADD COLUMN "manual_discount_applied_to_invoice" BOOLEAN NOT NULL DEFAULT false;

-- Cuanto del descuento manual de la cuenta absorbio este cargo puntual (ya
-- restado de amount) -- evita que buildLineItemsForBillableCharge tenga que
-- inferirlo de otro lado.
ALTER TABLE "billable_charge"
  ADD COLUMN "manual_discount_applied" DECIMAL(12,2) NOT NULL DEFAULT 0;
