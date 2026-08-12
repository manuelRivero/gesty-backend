/**
 * Viñeta de envío en mensajes de carrito del híbrido (present_cart, post-add).
 * El fulfillment suele estar vacío todavía: copy condicional según dirección
 * guardada y si el local ofrece delivery / retiro.
 */

import { findDefaultCustomerAddress } from '../repositories/customer.repository';
import { getBusinessConfig } from './businessConfig.service';
import { resolveDeliveryContext } from './deliveryFee.service';

export type CartShippingCopyInput = {
  deliveryEnabled: boolean;
  takeawayEnabled: boolean;
  fulfillmentType: 'DELIVERY' | 'TAKE_AWAY' | null;
  hasAddress: boolean;
  inCoverage: boolean;
  /** Monto de envío a la dirección guardada; null si no aplica / desconocido. */
  deliveryFee: number | null;
};

const money = (amount: number): string =>
  `$${amount.toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

/**
 * Una viñeta. Vacío si el local no ofrece ni delivery ni retiro (no debería pasar).
 */
export function formatCartShippingBullet(input: CartShippingCopyInput): string {
  const { deliveryEnabled, takeawayEnabled, fulfillmentType } = input;
  if (!deliveryEnabled && !takeawayEnabled) return '';

  // Ya eligió modalidad: el carrito muestra dirección / retiro aparte.
  if (fulfillmentType === 'TAKE_AWAY' || fulfillmentType === 'DELIVERY') {
    return '';
  }

  if (!deliveryEnabled && takeawayEnabled) {
    return '• *Envío:* retiro en el local, sin cargo.';
  }

  if (!takeawayEnabled && deliveryEnabled) {
    if (input.hasAddress && input.inCoverage && input.deliveryFee != null) {
      return input.deliveryFee > 0
        ? `• *Envío:* a tu dirección, ${money(input.deliveryFee)}.`
        : '• *Envío:* a tu dirección, sin cargo.';
    }
    if (input.hasAddress && !input.inCoverage) {
      return '• *Envío:* tu dirección actual queda fuera de zona; el monto se calcula al finalizar si hay otra dirección.';
    }
    return '• *Envío:* según tu dirección; el monto se calcula al finalizar el pedido.';
  }

  // Delivery + retiro, fulfillment aún no elegido (caso típico del híbrido).
  if (input.hasAddress && input.inCoverage && input.deliveryFee != null) {
    const feeBit =
      input.deliveryFee > 0
        ? `a tu dirección, ${money(input.deliveryFee)}`
        : 'a tu dirección, sin cargo';
    return `• *Envío:* ${feeBit}. El retiro en el local es sin cargo.`;
  }

  if (input.hasAddress && !input.inCoverage) {
    return '• *Envío:* retiro en el local, sin cargo. Esa dirección queda fuera de zona para delivery.';
  }

  return '• *Envío:* retiro en el local, sin cargo. Delivery según tu dirección; el monto se calcula al finalizar el pedido.';
}

export async function resolveCartShippingBullet(params: {
  businessId: string;
  customerId: string;
  fulfillmentType: 'DELIVERY' | 'TAKE_AWAY' | null;
}): Promise<string> {
  const cfg = await getBusinessConfig(params.businessId);
  const deliveryEnabled = cfg.delivery_enabled || cfg.external_delivery_enabled;
  const takeawayEnabled = cfg.takeaway_enabled;

  const address = await findDefaultCustomerAddress(params.customerId);
  const hasAddress = Boolean(address?.street_address);

  let inCoverage = false;
  let deliveryFee: number | null = null;
  if (deliveryEnabled && hasAddress && params.fulfillmentType !== 'TAKE_AWAY') {
    const ctx = await resolveDeliveryContext({
      customerId: params.customerId,
      businessId: params.businessId,
      fulfillmentType: 'DELIVERY',
    });
    inCoverage = ctx.zoneId !== null;
    deliveryFee = inCoverage ? ctx.deliveryFee : null;
  }

  return formatCartShippingBullet({
    deliveryEnabled,
    takeawayEnabled,
    fulfillmentType: params.fulfillmentType,
    hasAddress,
    inCoverage,
    deliveryFee,
  });
}
