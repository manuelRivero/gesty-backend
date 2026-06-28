import { prisma } from '../lib/prisma';
import { findCoverageZoneForAddress } from '../repositories/coverageZone.repository';

export interface ResolvedDeliveryContext {
  deliveryFee: number;
  minOrderAmount: number;
  zoneName: string | null;
  zoneId: string | null;
  /** Minutos estimados de entrega (informativo, no bloquea) */
  estimatedMinutes: number | null;
}

const NO_DELIVERY: ResolvedDeliveryContext = {
  deliveryFee: 0,
  minOrderAmount: 0,
  zoneName: null,
  zoneId: null,
  estimatedMinutes: null,
};

/**
 * Resuelve el costo de envío y el monto mínimo de pedido para un cliente dado
 * a partir de su dirección por defecto.
 *
 * - Si el fulfillment no es DELIVERY → devuelve fee=0, min=0.
 * - Si no hay dirección o no tiene zona asignada → fee=0, min=0.
 * - Si hay zona → devuelve sus valores configurados.
 */
export async function resolveDeliveryContext(params: {
  customerId: string;
  businessId: string;
  fulfillmentType: string | null | undefined;
}): Promise<ResolvedDeliveryContext> {
  if (params.fulfillmentType !== 'DELIVERY') {
    return NO_DELIVERY;
  }

  const address = await prisma.customer_address.findFirst({
    where: { customer_id: params.customerId, is_default: true },
    select: { id: true, delivery_zone_id: true },
  });

  if (!address) {
    return NO_DELIVERY;
  }

  const zone = await findCoverageZoneForAddress(address.id, params.businessId);

  if (!zone) {
    return NO_DELIVERY;
  }

  return {
    deliveryFee: zone.delivery_fee ? Number(zone.delivery_fee) : 0,
    minOrderAmount: zone.min_order_amount ? Number(zone.min_order_amount) : 0,
    zoneName: zone.name ?? null,
    zoneId: zone.id ?? null,
    estimatedMinutes: zone.estimated_delivery_minutes ?? null,
  };
}
