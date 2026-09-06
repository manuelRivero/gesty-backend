import {
  evaluateBusinessCapabilityAccess,
  ordersBlockedClientMessage,
} from '../services/evaluateBusinessCapabilityAccess.service';

export type OrdersCapabilityGateResult =
  | { ok: true }
  | { ok: false; error: 'orders_disabled'; message: string };

/**
 * Gate ADR-0002 para tools/handlers de pedido: exige `canOrder`.
 */
export async function assertCanOrder(
  businessId: string
): Promise<OrdersCapabilityGateResult> {
  const access = await evaluateBusinessCapabilityAccess(businessId);
  if (access.canOrder) {
    return { ok: true };
  }
  return {
    ok: false,
    error: 'orders_disabled',
    message: ordersBlockedClientMessage(access.hasReservations),
  };
}
