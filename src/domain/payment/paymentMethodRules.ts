import {
  getPaymentMethod,
  isPaymentMethodId,
  type PaymentMethodId,
} from './paymentMethods';

export class PaymentMethodCombinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaymentMethodCombinationError';
  }
}

export type ActivePaymentMethodSnapshot = {
  paymentMethod: string;
  isActive: boolean;
};

/**
 * Filtra métodos activos según compatibilidad con delivery externo.
 * No consulta DB: opera sobre IDs ya resueltos.
 */
export function filterMethodsForFulfillmentContext(
  methodIds: PaymentMethodId[],
  options: { externalDeliveryEnabled: boolean }
): PaymentMethodId[] {
  if (!options.externalDeliveryEnabled) return methodIds;
  return methodIds.filter((id) => getPaymentMethod(id).allowedWithExternalDelivery);
}

export function assertCashAllowedWithExternalDelivery(
  paymentMethod: string,
  externalDeliveryEnabled: boolean
): void {
  if (!externalDeliveryEnabled) return;
  if (paymentMethod === 'cash') {
    throw new PaymentMethodCombinationError(
      'Con delivery externo no se puede aceptar efectivo: el rider no pertenece al negocio'
    );
  }
}

/**
 * Valida el conjunto de métodos activos del local contra el flag de delivery externo.
 * - Con external ON: al menos un método no-cash activo.
 * - Siempre: al menos un método activo.
 */
export function assertValidPaymentMethodCombination(params: {
  activeMethods: ActivePaymentMethodSnapshot[];
  externalDeliveryEnabled: boolean;
}): void {
  const activeIds = params.activeMethods
    .filter((m) => m.isActive)
    .map((m) => m.paymentMethod)
    .filter(isPaymentMethodId);

  if (activeIds.length === 0) {
    throw new PaymentMethodCombinationError(
      'El negocio debe tener al menos un método de pago activo'
    );
  }

  if (params.externalDeliveryEnabled) {
    const hasNonCash = activeIds.some((id) => getPaymentMethod(id).allowedWithExternalDelivery);
    if (!hasNonCash) {
      throw new PaymentMethodCombinationError(
        'Con delivery externo necesitás al menos un método online o transferencia activo (efectivo no aplica)'
      );
    }
    if (activeIds.includes('cash')) {
      throw new PaymentMethodCombinationError(
        'Con delivery externo no se puede tener efectivo activo'
      );
    }
  }
}

/**
 * Proyecta el estado activo tras un create/update/delete de un método,
 * para validar la combinación resultante.
 */
export function projectActiveMethodsAfterChange(params: {
  current: ActivePaymentMethodSnapshot[];
  change:
    | { type: 'upsert'; paymentMethod: string; isActive: boolean }
    | { type: 'delete'; paymentMethod: string };
}): ActivePaymentMethodSnapshot[] {
  const byMethod = new Map(
    params.current.map((m) => [m.paymentMethod, { ...m }])
  );

  if (params.change.type === 'delete') {
    byMethod.delete(params.change.paymentMethod);
  } else {
    byMethod.set(params.change.paymentMethod, {
      paymentMethod: params.change.paymentMethod,
      isActive: params.change.isActive,
    });
  }

  return Array.from(byMethod.values());
}
