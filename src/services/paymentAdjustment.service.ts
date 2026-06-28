import { prisma } from '../lib/prisma';

export interface ResolvedPaymentAdjustment {
  /** Valor neto a aplicar al total: positivo = recargo, negativo = descuento */
  adjustmentAmount: number;
  /** Label configurado, ej: "Descuento por pago en efectivo" */
  label: string | null;
  /** true si hay ajuste activo para este método */
  hasAdjustment: boolean;
}

const NO_ADJUSTMENT: ResolvedPaymentAdjustment = {
  adjustmentAmount: 0,
  label: null,
  hasAdjustment: false,
};

/**
 * Busca la configuración de ajuste para un método de pago dado y calcula
 * el monto neto a sumar (recargo) o restar (descuento) del total del pedido.
 *
 * La base para calcular porcentajes es el subtotal neto (subtotal − descuentos
 * de producto + delivery fee), es decir, el total antes del ajuste de pago.
 */
export async function resolvePaymentAdjustment(params: {
  businessId: string;
  paymentMethod: string;
  /** Total pre-ajuste: subtotal − descuentos + delivery fee */
  baseAmount: number;
}): Promise<ResolvedPaymentAdjustment> {
  const config = await prisma.payment_method_config.findFirst({
    where: {
      business_id: params.businessId,
      payment_method: params.paymentMethod,
      is_active: true,
    },
  });

  if (!config) return NO_ADJUSTMENT;

  const value = Number(config.adjustment_value);
  let magnitude: number;

  if (config.adjustment_type === 'PERCENT') {
    magnitude = Math.round((params.baseAmount * value) / 100 * 100) / 100;
  } else {
    magnitude = value;
  }

  const adjustmentAmount = config.is_surcharge ? magnitude : -magnitude;

  return {
    adjustmentAmount,
    label: config.label,
    hasAdjustment: magnitude > 0,
  };
}

/**
 * Lista todos los ajustes activos de un negocio, enriquecidos con el monto
 * calculado para un total dado. Útil para mostrar opciones de pago con precios.
 */
export async function listPaymentAdjustmentsForAmount(params: {
  businessId: string;
  baseAmount: number;
}): Promise<
  Array<{
    paymentMethod: string;
    label: string;
    adjustmentAmount: number;
    finalAmount: number;
    isSurcharge: boolean;
  }>
> {
  const configs = await prisma.payment_method_config.findMany({
    where: { business_id: params.businessId, is_active: true },
  });

  return configs.map((c) => {
    const value = Number(c.adjustment_value);
    const magnitude =
      c.adjustment_type === 'PERCENT'
        ? Math.round((params.baseAmount * value) / 100 * 100) / 100
        : value;
    const adjustmentAmount = c.is_surcharge ? magnitude : -magnitude;
    return {
      paymentMethod: c.payment_method,
      label: c.label,
      adjustmentAmount,
      finalAmount: params.baseAmount + adjustmentAmount,
      isSurcharge: c.is_surcharge,
    };
  });
}
