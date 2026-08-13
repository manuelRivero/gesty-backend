import { prisma } from '../../lib/prisma';
import {
  FULFILLMENT_LABEL_ES,
  IN_FLIGHT_ORDER_STATUSES,
  ORDER_STATUS_LABEL_ES,
  PAYMENT_STATUS_LABEL_ES,
  shortOrderId,
} from './labels';

export async function getLiveOrdersSnapshot(businessId: string) {
  const orders = await prisma.orders.findMany({
    where: {
      business_id: businessId,
      status: { in: IN_FLIGHT_ORDER_STATUSES },
    },
    select: {
      id: true,
      status: true,
      fulfillment_type: true,
      payment_status: true,
      total_amount: true,
      created_at: true,
      customer: { select: { name: true, phone_number: true } },
    },
    orderBy: { created_at: 'asc' },
    take: 40,
  });

  const now = Date.now();
  const items = orders.map((order) => ({
    id: order.id,
    shortId: shortOrderId(order.id),
    status: order.status,
    statusLabel: ORDER_STATUS_LABEL_ES[order.status],
    fulfillment: order.fulfillment_type,
    fulfillmentLabel: order.fulfillment_type
      ? FULFILLMENT_LABEL_ES[order.fulfillment_type]
      : null,
    paymentStatus: order.payment_status,
    paymentLabel: PAYMENT_STATUS_LABEL_ES[order.payment_status],
    total: order.total_amount != null ? Number(order.total_amount) : null,
    customerName: order.customer.name,
    customerPhone: order.customer.phone_number,
    createdAt: order.created_at.toISOString(),
    minutesAgo: Math.max(0, Math.round((now - order.created_at.getTime()) / 60000)),
  }));

  const byStatus = Object.fromEntries(
    IN_FLIGHT_ORDER_STATUSES.map((status) => [
      status,
      {
        label: ORDER_STATUS_LABEL_ES[status],
        items: items.filter((item) => item.status === status),
      },
    ])
  );

  return {
    total: items.length,
    truncated: orders.length === 40,
    byStatus,
  };
}
