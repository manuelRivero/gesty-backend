import { OrderPaymentStatus, OrderStatus, FulfillmentType } from '@prisma/client';

export const IN_FLIGHT_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.placed,
  OrderStatus.preparing,
  OrderStatus.ready_for_pickup,
  OrderStatus.shipped,
];

export const ORDER_STATUS_LABEL_ES: Record<OrderStatus, string> = {
  [OrderStatus.draft]: 'borrador',
  [OrderStatus.placed]: 'en cola',
  [OrderStatus.preparing]: 'en cocina',
  [OrderStatus.ready_for_pickup]: 'listo para retirar',
  [OrderStatus.shipped]: 'en camino',
  [OrderStatus.delivered]: 'entregado',
  [OrderStatus.cancelled]: 'cancelado',
};

export const PAYMENT_STATUS_LABEL_ES: Record<OrderPaymentStatus, string> = {
  [OrderPaymentStatus.unpaid]: 'impago',
  [OrderPaymentStatus.paid]: 'cobrado',
};

export const FULFILLMENT_LABEL_ES: Record<FulfillmentType, string> = {
  [FulfillmentType.DELIVERY]: 'delivery',
  [FulfillmentType.TAKE_AWAY]: 'retiro',
};

export const shortOrderId = (orderId: string): string =>
  orderId.replace(/-/g, '').slice(0, 8);
