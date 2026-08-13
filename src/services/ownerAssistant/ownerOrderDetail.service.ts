import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import {
  FULFILLMENT_LABEL_ES,
  ORDER_STATUS_LABEL_ES,
  PAYMENT_STATUS_LABEL_ES,
  shortOrderId,
} from './labels';

export type OwnerOrderDetailError = {
  error: 'order_not_found' | 'ambiguous_order';
  missing?: 'order';
  candidates?: Array<{ shortId: string; customerName: string | null }>;
};

const isUuid = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const ORDER_DETAIL_INCLUDE = {
  customer: { select: { name: true, phone_number: true } },
  order_item: {
    include: { menu_item: { select: { name: true } } },
    orderBy: { created_at: 'asc' as const },
  },
} satisfies Prisma.ordersInclude;

type OrderDetailRow = Prisma.ordersGetPayload<{ include: typeof ORDER_DETAIL_INCLUDE }>;

type AddressSnapshot = {
  street_address?: string;
  apartment?: string;
  neighborhood?: string;
  city?: string;
};

const loadOrderById = (businessId: string, id: string) =>
  prisma.orders.findFirst({
    where: { id, business_id: businessId },
    include: ORDER_DETAIL_INCLUDE,
  });

export async function getOwnerOrderDetail(
  businessId: string,
  orderRef: string
): Promise<Record<string, unknown> | OwnerOrderDetailError> {
  const ref = orderRef.trim();
  if (!ref) {
    return { error: 'order_not_found', missing: 'order' };
  }

  const loaded = isUuid(ref)
    ? await loadOrderById(businessId, ref)
    : await findByShortId(businessId, ref);

  if (loaded && 'error' in loaded) return loaded;
  if (!loaded) return { error: 'order_not_found', missing: 'order' };

  const order: OrderDetailRow = loaded;
  const snapshot = (order.delivery_address_snapshot ?? {}) as AddressSnapshot;

  return {
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
    paymentMethod: order.payment_method,
    total: order.total_amount != null ? Number(order.total_amount) : null,
    deliveryFee: order.delivery_fee != null ? Number(order.delivery_fee) : null,
    createdAt: order.created_at.toISOString(),
    customerName: order.customer.name,
    customerPhone: order.customer.phone_number,
    address: order.fulfillment_type === 'DELIVERY'
      ? {
          street: snapshot.street_address ?? null,
          apartment: snapshot.apartment ?? null,
          neighborhood: snapshot.neighborhood ?? null,
          city: snapshot.city ?? null,
        }
      : null,
    items: order.order_item.map((line) => ({
      name: line.menu_item.name,
      quantity: line.quantity,
      variation: line.variation,
      unitPrice: Number(line.unit_price),
      notes: line.notes,
    })),
  };
}

async function findByShortId(
  businessId: string,
  shortId: string
): Promise<OrderDetailRow | OwnerOrderDetailError | null> {
  const needle = shortId.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(needle)) {
    return null;
  }

  const ids = await prisma.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT o.id::text AS id
      FROM orders o
      WHERE o.business_id = ${businessId}::uuid
        AND replace(o.id::text, '-', '') LIKE ${needle + '%'}
      LIMIT 5
    `
  );

  if (ids.length === 0) return null;

  const matches = await prisma.orders.findMany({
    where: { business_id: businessId, id: { in: ids.map((row) => row.id) } },
    include: ORDER_DETAIL_INCLUDE,
  });

  const exact = matches.filter((row) => shortOrderId(row.id) === needle);
  const pool = exact.length > 0 ? exact : matches;
  if (pool.length === 0) return null;
  if (pool.length > 1) {
    return {
      error: 'ambiguous_order',
      missing: 'order',
      candidates: pool.map((row) => ({
        shortId: shortOrderId(row.id),
        customerName: row.customer.name,
      })),
    };
  }
  return pool[0];
}
