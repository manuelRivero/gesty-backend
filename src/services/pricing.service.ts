import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type DiscountType = 'PERCENT' | 'FIXED';

export interface PricingItem {
  quantity: number;
  unit_price: Prisma.Decimal;
  /** Precio de lista antes del descuento (si null se usa unit_price como base) */
  list_price?: Prisma.Decimal | null;
  /** Descuento ya aplicado a esta línea (para computeOrderPricing en re-cálculos) */
  discount_amount?: Prisma.Decimal | null;
}

/**
 * Resultado desglosado del cálculo de precio de una orden.
 *
 * Fases siguientes poblarán:
 *   - Fase 2: deliveryFee (zona de cobertura)
 *   - Fase 3: paymentAdjustment (recargo/descuento por método de pago)
 */
export interface PricingResult {
  /** Suma de (quantity × list_price) sin ningún ajuste */
  subtotal: number;
  /** Descuentos aplicados a líneas de producto (siempre positivo) */
  productDiscounts: number;
  /**
   * Total de los platos ya con el descuento de catálogo aplicado
   * (`subtotal − productDiscounts`) y **antes** de promociones.
   *
   * Existe para que nadie vuelva a calcularlo a mano en cada caller (había dos
   * copias de esa resta) y porque es la base que evalúa `cart.subtotal` del DSL
   * de promociones (D1).
   */
  itemsTotal: number;
  /** Descuento promocional del pedido (D3/D5). Siempre positivo. */
  promotionDiscount: number;
  /** Costo de envío */
  deliveryFee: number;
  /** Recargo (+) o descuento (−) por método de pago */
  paymentAdjustment: number;
  /** Total final que se cobra al cliente */
  total: number;
}

export interface ResolvedItemPrice {
  /** Precio de catálogo sin descuento */
  listPrice: Prisma.Decimal;
  /** Descuento aplicado (0 si no hay descuento) */
  discountAmount: Prisma.Decimal;
  /** Precio final que se cobra: listPrice − discountAmount */
  finalPrice: Prisma.Decimal;
  /** true si hay algún descuento activo */
  hasDiscount: boolean;
}

// ---------------------------------------------------------------------------
// Helpers de descuento por ítem
// ---------------------------------------------------------------------------

/**
 * Calcula el precio efectivo de un ítem aplicando la regla de descuento.
 *
 * @param listPrice  Precio base del catálogo (menu_item_price.amount)
 * @param discountType  'PERCENT' | 'FIXED' | null
 * @param discountValue  El valor del descuento (15 para 15% o 500 para $500 fijo)
 */
export function resolveItemDiscount(
  listPrice: Prisma.Decimal,
  discountType: string | null | undefined,
  discountValue: Prisma.Decimal | null | undefined
): ResolvedItemPrice {
  if (!discountType || !discountValue || discountValue.lte(0)) {
    return {
      listPrice,
      discountAmount: new Prisma.Decimal(0),
      finalPrice: listPrice,
      hasDiscount: false,
    };
  }

  let discountAmount: Prisma.Decimal;

  if (discountType === 'PERCENT') {
    // Porcentaje: no puede superar el 100 %
    const pct = discountValue.gt(100) ? new Prisma.Decimal(100) : discountValue;
    discountAmount = listPrice.mul(pct).div(100).toDecimalPlaces(2);
  } else {
    // Monto fijo: no puede superar el precio de lista
    discountAmount = discountValue.gt(listPrice) ? listPrice : discountValue;
    discountAmount = discountAmount.toDecimalPlaces(2);
  }

  const finalPrice = listPrice.minus(discountAmount);

  return {
    listPrice,
    discountAmount,
    finalPrice,
    hasDiscount: discountAmount.gt(0),
  };
}

// ---------------------------------------------------------------------------
// Cálculo del total del pedido
// ---------------------------------------------------------------------------

/**
 * Fuente de verdad única para calcular el precio de un pedido a partir de
 * las líneas del carrito. Devuelve el desglose completo.
 *
 * - Si el ítem tiene `list_price` y `discount_amount` ya congelados (ítems
 *   recuperados de la BD), los usa directamente para el desglose.
 * - Si no, asume que `unit_price` es el precio final sin descuento registrado.
 * - `deliveryFee` se suma al total (solo si fulfillment = DELIVERY).
 * - `promotionDiscount` (D5) entra **antes** del ajuste por método de pago:
 *   el porcentaje del recargo/descuento se calcula sobre lo que el cliente
 *   realmente paga, igual que ya ocurría con los descuentos de catálogo.
 *
 * Fórmula (única, no configurable):
 *   itemsTotal = subtotal − productDiscounts
 *   base       = itemsTotal − promotionDiscount + deliveryFee
 *   total      = base + paymentAdjustment
 */
export function computeOrderPricing(
  items: PricingItem[],
  options: {
    deliveryFee?: number;
    paymentAdjustment?: number;
    promotionDiscount?: number;
  } = {}
): PricingResult {
  let subtotal = 0;
  let productDiscounts = 0;

  for (const item of items) {
    const lp = item.list_price ?? item.unit_price;
    const da = item.discount_amount ?? new Prisma.Decimal(0);

    subtotal += item.quantity * lp.toNumber();
    productDiscounts += item.quantity * da.toNumber();
  }

  const itemsTotal = subtotal - productDiscounts;
  const deliveryFee = options.deliveryFee ?? 0;
  const paymentAdjustment = options.paymentAdjustment ?? 0;
  // Tope defensivo: el evaluador ya lo acota, pero el total de ítems no puede
  // quedar negativo por un llamador que pase cualquier cosa.
  const promotionDiscount = Math.min(
    Math.max(options.promotionDiscount ?? 0, 0),
    itemsTotal
  );

  return {
    subtotal,
    productDiscounts,
    itemsTotal,
    promotionDiscount,
    deliveryFee,
    paymentAdjustment,
    total: itemsTotal - promotionDiscount + deliveryFee + paymentAdjustment,
  };
}

/**
 * Versión Decimal de la suma del carrito para usar dentro de transacciones
 * Prisma donde los ítems ya están hidratados con `total_price`.
 */
export function computeCartTotalDecimal(
  items: Array<{ total_price: Prisma.Decimal }>
): Prisma.Decimal {
  return items.reduce(
    (acc, item) => acc.add(item.total_price),
    new Prisma.Decimal(0)
  );
}

// ---------------------------------------------------------------------------
// Helpers de formato para mensajes WhatsApp
// ---------------------------------------------------------------------------

/**
 * Formatea el precio de un ítem para mostrar en WhatsApp.
 * Si hay descuento muestra "~~$1000~~ $850 (-15%)" (tachado no disponible en WA,
 * pero el formato textual es claro).
 */
export function formatItemPriceForChat(
  resolved: ResolvedItemPrice,
  currencySymbol: string = '$'
): string {
  if (!resolved.hasDiscount) {
    return `${currencySymbol}${resolved.finalPrice.toFixed(2)}`;
  }

  const pct = resolved.listPrice.gt(0)
    ? resolved.discountAmount.mul(100).div(resolved.listPrice).toDecimalPlaces(0)
    : new Prisma.Decimal(0);

  return `${currencySymbol}${resolved.finalPrice.toFixed(2)} (antes ${currencySymbol}${resolved.listPrice.toFixed(2)}, -${pct}%)`;
}
