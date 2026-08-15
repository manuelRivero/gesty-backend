import { OrderPaymentStatus, OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ConversationSentiment } from '../../types/conversationSentiment';
import { FRUSTRATED_SAMPLE_LIMIT } from './ownerMetrics.definitions';
import { IN_FLIGHT_ORDER_STATUSES, ORDER_STATUS_LABEL_ES } from './labels';

export type InstantWindow = {
  startAt: Date;
  endAt: Date;
};

const COMPLAINT_SENTIMENTS: ConversationSentiment[] = [
  ConversationSentiment.FRUSTRATED,
  ConversationSentiment.NEEDS_HUMAN,
];

export type SalesOrdersAgg = {
  sales: number;
  orders: number;
};

export async function querySalesAndOrders(
  businessId: string,
  window: InstantWindow
): Promise<SalesOrdersAgg> {
  const rows = await prisma.$queryRaw<
    Array<{ sales: string | null; orders: bigint }>
  >(
    Prisma.sql`
      SELECT
        COALESCE(SUM(o.total_amount), 0)::text AS sales,
        COUNT(*)::bigint AS orders
      FROM orders o
      WHERE o.business_id = ${businessId}::uuid
        AND o.created_at >= ${window.startAt}
        AND o.created_at < ${window.endAt}
        AND o.status <> ${OrderStatus.draft}::"OrderStatus"
        AND o.status <> ${OrderStatus.cancelled}::"OrderStatus"
    `
  );
  return {
    sales: rows[0]?.sales != null ? parseFloat(rows[0].sales) : 0,
    orders: Number(rows[0]?.orders ?? 0),
  };
}

export async function queryCancelledCount(
  businessId: string,
  window: InstantWindow
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM orders o
      WHERE o.business_id = ${businessId}::uuid
        AND o.created_at >= ${window.startAt}
        AND o.created_at < ${window.endAt}
        AND o.status = ${OrderStatus.cancelled}::"OrderStatus"
    `
  );
  return Number(rows[0]?.count ?? 0);
}

export type TopProductRow = {
  menuItemId: string;
  name: string;
  units: number;
  productSalesAmount: number;
};

export async function queryTopProducts(
  businessId: string,
  window: InstantWindow,
  limit: number
): Promise<TopProductRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      menu_item_id: string;
      name: string;
      units: bigint;
      product_sales: string | null;
    }>
  >(
    Prisma.sql`
      SELECT
        oi.menu_item_id::text AS menu_item_id,
        mi.name,
        SUM(oi.quantity)::bigint AS units,
        SUM(oi.quantity * oi.unit_price)::text AS product_sales
      FROM order_item oi
      JOIN orders o ON o.id = oi.order_id
      JOIN menu_item mi ON mi.id = oi.menu_item_id
      WHERE o.business_id = ${businessId}::uuid
        AND o.created_at >= ${window.startAt}
        AND o.created_at < ${window.endAt}
        AND o.status <> ${OrderStatus.draft}::"OrderStatus"
        AND o.status <> ${OrderStatus.cancelled}::"OrderStatus"
      GROUP BY oi.menu_item_id, mi.name
      ORDER BY SUM(oi.quantity) DESC
      LIMIT ${limit}
    `
  );
  return rows.map((r) => ({
    menuItemId: r.menu_item_id,
    name: r.name,
    units: Number(r.units),
    productSalesAmount:
      r.product_sales != null ? parseFloat(r.product_sales) : 0,
  }));
}

export async function queryUnpaidValidOrders(
  businessId: string,
  window: InstantWindow
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM orders o
      WHERE o.business_id = ${businessId}::uuid
        AND o.created_at >= ${window.startAt}
        AND o.created_at < ${window.endAt}
        AND o.status <> ${OrderStatus.draft}::"OrderStatus"
        AND o.status <> ${OrderStatus.cancelled}::"OrderStatus"
        AND o.payment_status = ${OrderPaymentStatus.unpaid}::"OrderPaymentStatus"
    `
  );
  return Number(rows[0]?.count ?? 0);
}

export type FrustratedSampleRow = {
  customerName: string | null;
  sentiment: string;
};

export async function queryFrustratedCount(
  businessId: string,
  window: InstantWindow,
  excludeCustomerId?: string | null
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(
    excludeCustomerId
      ? Prisma.sql`
          SELECT COUNT(*)::bigint AS count
          FROM conversation c
          WHERE c.business_id = ${businessId}::uuid
            AND c.ai_sentiment IN (${Prisma.join(COMPLAINT_SENTIMENTS)})
            AND c.ai_sentiment_updated_at IS NOT NULL
            AND c.ai_sentiment_updated_at >= ${window.startAt}
            AND c.ai_sentiment_updated_at < ${window.endAt}
            AND c.customer_id <> ${excludeCustomerId}::uuid
        `
      : Prisma.sql`
          SELECT COUNT(*)::bigint AS count
          FROM conversation c
          WHERE c.business_id = ${businessId}::uuid
            AND c.ai_sentiment IN (${Prisma.join(COMPLAINT_SENTIMENTS)})
            AND c.ai_sentiment_updated_at IS NOT NULL
            AND c.ai_sentiment_updated_at >= ${window.startAt}
            AND c.ai_sentiment_updated_at < ${window.endAt}
        `
  );
  return Number(rows[0]?.count ?? 0);
}

export async function queryFrustratedSample(
  businessId: string,
  window: InstantWindow,
  excludeCustomerId?: string | null
): Promise<FrustratedSampleRow[]> {
  const rows = await prisma.$queryRaw<
    Array<{ customer_name: string | null; sentiment: string }>
  >(
    excludeCustomerId
      ? Prisma.sql`
          SELECT cu.name AS customer_name, c.ai_sentiment AS sentiment
          FROM conversation c
          JOIN customer cu ON cu.id = c.customer_id
          WHERE c.business_id = ${businessId}::uuid
            AND c.ai_sentiment IN (${Prisma.join(COMPLAINT_SENTIMENTS)})
            AND c.ai_sentiment_updated_at IS NOT NULL
            AND c.ai_sentiment_updated_at >= ${window.startAt}
            AND c.ai_sentiment_updated_at < ${window.endAt}
            AND c.customer_id <> ${excludeCustomerId}::uuid
          ORDER BY c.ai_sentiment_updated_at DESC
          LIMIT ${FRUSTRATED_SAMPLE_LIMIT}
        `
      : Prisma.sql`
          SELECT cu.name AS customer_name, c.ai_sentiment AS sentiment
          FROM conversation c
          JOIN customer cu ON cu.id = c.customer_id
          WHERE c.business_id = ${businessId}::uuid
            AND c.ai_sentiment IN (${Prisma.join(COMPLAINT_SENTIMENTS)})
            AND c.ai_sentiment_updated_at IS NOT NULL
            AND c.ai_sentiment_updated_at >= ${window.startAt}
            AND c.ai_sentiment_updated_at < ${window.endAt}
          ORDER BY c.ai_sentiment_updated_at DESC
          LIMIT ${FRUSTRATED_SAMPLE_LIMIT}
        `
  );
  return rows.map((r) => ({
    customerName: r.customer_name,
    sentiment: r.sentiment,
  }));
}

export async function queryInFlightByStatus(
  businessId: string
): Promise<{ total: number; byStatus: Record<string, { count: number; label: string }> }> {
  const groups = await prisma.orders.groupBy({
    by: ['status'],
    where: {
      business_id: businessId,
      status: { in: [...IN_FLIGHT_ORDER_STATUSES] },
    },
    _count: { _all: true },
  });
  const counts = Object.fromEntries(
    groups.map((row) => [row.status, row._count._all])
  );
  let total = 0;
  const byStatus = Object.fromEntries(
    IN_FLIGHT_ORDER_STATUSES.map((status) => {
      const count = counts[status] ?? 0;
      total += count;
      return [status, { count, label: ORDER_STATUS_LABEL_ES[status] }];
    })
  );
  return { total, byStatus };
}

export async function queryHumanHandledOpen(
  businessId: string,
  excludeCustomerId?: string | null
): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(
    excludeCustomerId
      ? Prisma.sql`
          SELECT COUNT(*)::bigint AS count
          FROM conversation c
          JOIN conversation_state cs ON cs.conversation_id = c.id
          WHERE c.business_id = ${businessId}::uuid
            AND c.status = 'open'
            AND cs.is_human_handled = true
            AND c.customer_id <> ${excludeCustomerId}::uuid
        `
      : Prisma.sql`
          SELECT COUNT(*)::bigint AS count
          FROM conversation c
          JOIN conversation_state cs ON cs.conversation_id = c.id
          WHERE c.business_id = ${businessId}::uuid
            AND c.status = 'open'
            AND cs.is_human_handled = true
        `
  );
  return Number(rows[0]?.count ?? 0);
}
