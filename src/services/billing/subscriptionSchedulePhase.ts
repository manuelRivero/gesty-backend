import type Stripe from "stripe";

/**
 * Reconstrucción de la fase VIGENTE de un Subscription Schedule al
 * reemplazar sus fases (Fase 2, sección 6). El código anterior armaba esa
 * fase copiando solo `items[].price`/`items[].quantity` — cualquier
 * descuento, impuesto o metadata configurada en la fase (o en sus items)
 * se perdía en silencio al programar un downgrade.
 *
 * `stripe.subscriptionSchedules.update` reemplaza TODAS las fases por las
 * que se le pasan — no hay forma de "editar solo una fase futura" sin
 * reenviar también la vigente. Por eso hace falta reconstruirla fielmente
 * a partir del objeto que YA devolvió Stripe (`schedule.phases[i]`, de
 * lectura), convirtiendo cada referencia expandida u opcional al formato
 * de escritura que espera la API de update (ids, nunca objetos completos).
 *
 * Campos que SÍ se preservan: items (precio, cantidad, descuentos, tax
 * rates, metadata), descuentos y tax rates a nivel de fase, `automatic_tax`,
 * `metadata`, `collection_method`, y los campos de trial si la fase vigente
 * está en trial.
 *
 * Campos que esto NO sabe preservar todavía: `add_invoice_items`,
 * `billing_thresholds` (a nivel de fase o de item), `invoice_settings`
 * no trivial, `transfer_data`, `application_fee_percent`, `on_behalf_of`.
 * `detectUnsupportedPhaseConfig` los detecta explícitamente — el llamador
 * (`subscriptionChangePlan.service.ts`) usa eso para RECHAZAR el downgrade
 * en vez de aplicarlo perdiendo esa configuración en silencio.
 */

type WritePhase = Stripe.SubscriptionScheduleUpdateParams.Phase;
type WriteItem = Stripe.SubscriptionScheduleUpdateParams.Phase.Item;
type WriteDiscount = Stripe.SubscriptionScheduleUpdateParams.Phase.Discount;
type ReadPhase = Stripe.SubscriptionSchedule.Phase;
type ReadItem = Stripe.SubscriptionSchedule.Phase.Item;
type ReadDiscount = Stripe.SubscriptionSchedule.Phase.Discount;

function idOf(
  value: string | { id: string } | null | undefined
): string | undefined {
  if (value == null) return undefined;
  return typeof value === "string" ? value : value.id;
}

function convertDiscount(discount: ReadDiscount): WriteDiscount {
  const out: WriteDiscount = {};
  const coupon = idOf(discount.coupon);
  if (coupon) out.coupon = coupon;
  const existingDiscount = idOf(discount.discount);
  if (existingDiscount) out.discount = existingDiscount;
  const promotionCode = idOf(discount.promotion_code);
  if (promotionCode) out.promotion_code = promotionCode;
  return out;
}

function convertItem(item: ReadItem): WriteItem {
  const price = idOf(item.price);
  if (!price) {
    throw Object.assign(
      new Error("No se pudo resolver el precio de un item de la fase vigente del schedule."),
      { status: 502 }
    );
  }
  const out: WriteItem = { price, quantity: item.quantity ?? 1 };
  if (item.discounts && item.discounts.length > 0) {
    out.discounts = item.discounts.map(convertDiscount);
  }
  if (item.tax_rates && item.tax_rates.length > 0) {
    out.tax_rates = item.tax_rates.map((rate) => rate.id);
  }
  if (item.metadata && Object.keys(item.metadata).length > 0) {
    out.metadata = item.metadata;
  }
  return out;
}

/**
 * Campos presentes en la fase vigente que esta función todavía no sabe
 * preservar con seguridad al reconstruirla. Lista vacía = seguro de
 * reconstruir con `buildPreservedActivePhase`.
 */
export function detectUnsupportedPhaseConfig(phase: ReadPhase): string[] {
  const found: string[] = [];
  if (phase.add_invoice_items && phase.add_invoice_items.length > 0) {
    found.push("add_invoice_items");
  }
  if (phase.billing_thresholds) {
    found.push("billing_thresholds (fase)");
  }
  if (phase.items.some((item) => item.billing_thresholds)) {
    found.push("billing_thresholds (item)");
  }
  if (phase.invoice_settings && hasInvoiceSettingsCustomization(phase.invoice_settings)) {
    found.push("invoice_settings");
  }
  if (phase.transfer_data) {
    found.push("transfer_data");
  }
  if (phase.application_fee_percent != null) {
    found.push("application_fee_percent");
  }
  if (phase.on_behalf_of) {
    found.push("on_behalf_of");
  }
  return found;
}

function hasInvoiceSettingsCustomization(
  settings: NonNullable<ReadPhase["invoice_settings"]>
): boolean {
  return Boolean(
    (settings.account_tax_ids && settings.account_tax_ids.length > 0) ||
      (settings.custom_fields && settings.custom_fields.length > 0) ||
      settings.days_until_due != null ||
      settings.description != null ||
      settings.footer != null
  );
}

/**
 * Reconstruye la fase vigente para el payload de `phases` de
 * `subscriptionSchedules.update`, preservando lo que `detectUnsupportedPhaseConfig`
 * no haya marcado como no soportado. El llamador debe verificar esa
 * función ANTES de llamar a esta — acá no se vuelve a chequear, para que
 * el llamador decida qué hacer con la lista (rechazar la operación) en un
 * solo lugar.
 */
export function buildPreservedActivePhase(phase: ReadPhase): WritePhase {
  const out: WritePhase = {
    items: phase.items.map(convertItem),
    start_date: phase.start_date,
    end_date: phase.end_date,
    // "none": esta fase ya está vigente, reconstruirla con los mismos
    // items/precios no debe generar una proración — la proración relevante
    // (si la hubiera) es la de pasar a la fase nueva, no la de "re-entrar"
    // a esta misma fase con los mismos datos.
    proration_behavior: "none",
  };

  if (phase.discounts && phase.discounts.length > 0) {
    out.discounts = phase.discounts.map(convertDiscount);
  }
  if (phase.automatic_tax) {
    out.automatic_tax = {
      enabled: phase.automatic_tax.enabled,
      ...(phase.automatic_tax.liability
        ? {
            liability: {
              type: phase.automatic_tax.liability.type,
              ...(idOf(phase.automatic_tax.liability.account)
                ? { account: idOf(phase.automatic_tax.liability.account) }
                : {}),
            },
          }
        : {}),
    };
  }
  if (phase.metadata && Object.keys(phase.metadata).length > 0) {
    out.metadata = phase.metadata;
  }
  if (phase.collection_method) {
    out.collection_method = phase.collection_method;
  }
  if (phase.default_tax_rates && phase.default_tax_rates.length > 0) {
    out.default_tax_rates = phase.default_tax_rates.map((rate) => rate.id);
  }
  if (phase.trial) {
    out.trial = phase.trial;
  }
  if (phase.trial_end != null) {
    out.trial_end = phase.trial_end;
  }

  return out;
}
