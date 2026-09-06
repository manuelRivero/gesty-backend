import { prisma } from '../lib/prisma';
import {
  getBusinessConfig,
  type BusinessConfig,
} from './businessConfig.service';
import { listOfferedPaymentMethods } from './paymentMethods.service';
import { formatBotUserMessage } from './productQuery/utils';

export type CapabilityAccessMode =
  | 'full'
  | 'reservations_only'
  | 'orders_only'
  | 'blocked';

export type CapabilityAccessResult = {
  mode: CapabilityAccessMode;
  canOrder: boolean;
  hasReservations: boolean;
  hasPayment: boolean;
  hasActiveMenu: boolean;
  hasFulfillment: boolean;
  reason: string;
  /** Mensaje al cliente solo cuando `mode === 'blocked'`. */
  message: string | null;
};

/** Copy WhatsApp — bloqueo total (D15 / §2.1). */
export const CAPABILITY_BLOCKED_MESSAGE = formatBotUserMessage(
  'Asistente',
  '🛠️',
  'Este local todavía está configurando el asistente.\n' +
    'Por ahora no podemos tomar pedidos ni reservas por este chat.'
);

/** Copy WhatsApp — rechazo de pedido cuando solo hay reservas (D15 / §2.1). */
export const ORDERS_BLOCKED_RESERVATIONS_ONLY_MESSAGE =
  'Por ahora este local solo toma reservas por este chat, no pedidos a domicilio ni para llevar.\n' +
  'Si querés una mesa, pedime reservar.';

/** Copy genérico cuando el local no toma pedidos (sin reservas). */
export const ORDERS_BLOCKED_MESSAGE =
  'Por ahora este local no toma pedidos por este chat.';

export function hasFulfillmentCapability(config: BusinessConfig): boolean {
  return (
    config.delivery_enabled ||
    config.takeaway_enabled ||
    config.external_delivery_enabled
  );
}

export function ordersBlockedClientMessage(hasReservations: boolean): string {
  return hasReservations
    ? ORDERS_BLOCKED_RESERVATIONS_ONLY_MESSAGE
    : ORDERS_BLOCKED_MESSAGE;
}

/**
 * Evalúa capacidades del local para el bot (D4–D8, D12).
 * `canOrder` exige flag + pago ofrecible + menú activo + fulfillment.
 */
export async function evaluateBusinessCapabilityAccess(
  businessId: string,
  config?: BusinessConfig
): Promise<CapabilityAccessResult> {
  const businessConfig = config ?? (await getBusinessConfig(businessId));

  const [offered, activeMenuCount] = await Promise.all([
    listOfferedPaymentMethods(businessId, {
      externalDeliveryEnabled: businessConfig.external_delivery_enabled,
    }),
    prisma.menu_item.count({
      where: { business_id: businessId, is_available: true },
    }),
  ]);

  const hasPayment = offered.length > 0;
  const hasActiveMenu = activeMenuCount > 0;
  const hasFulfillment = hasFulfillmentCapability(businessConfig);
  const hasReservations = businessConfig.reservations_enabled === true;
  const canOrder =
    businessConfig.orders_enabled === true &&
    hasPayment &&
    hasActiveMenu &&
    hasFulfillment;

  if (!canOrder && !hasReservations) {
    return {
      mode: 'blocked',
      canOrder,
      hasReservations,
      hasPayment,
      hasActiveMenu,
      hasFulfillment,
      reason: 'no_orders_no_reservations',
      message: CAPABILITY_BLOCKED_MESSAGE,
    };
  }

  if (canOrder && hasReservations) {
    return {
      mode: 'full',
      canOrder,
      hasReservations,
      hasPayment,
      hasActiveMenu,
      hasFulfillment,
      reason: 'ok',
      message: null,
    };
  }

  if (hasReservations && !canOrder) {
    return {
      mode: 'reservations_only',
      canOrder,
      hasReservations,
      hasPayment,
      hasActiveMenu,
      hasFulfillment,
      reason: 'orders_unavailable',
      message: null,
    };
  }

  return {
    mode: 'orders_only',
    canOrder,
    hasReservations,
    hasPayment,
    hasActiveMenu,
    hasFulfillment,
    reason: 'ok',
    message: null,
  };
}
