import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { ConversationSentiment } from '../../types/conversationSentiment';
import { getAdminDashboardSummary } from '../adminDashboard.service';
import {
  FULFILLMENT_LABEL_ES,
  IN_FLIGHT_ORDER_STATUSES,
  ORDER_STATUS_LABEL_ES,
} from './labels';

export type OwnerBriefingInput = {
  businessId: string;
  from: string;
  to: string;
  tz: string;
  excludeCustomerId?: string;
};

type ComplaintRow = {
  id: string;
  sentiment: string;
  updated_at: Date;
  customer_name: string | null;
};

const COMPLAINT_SENTIMENTS: ConversationSentiment[] = [
  ConversationSentiment.FRUSTRATED,
  ConversationSentiment.NEEDS_HUMAN,
];

export async function getOwnerBriefing(input: OwnerBriefingInput) {
  const dashboard = await getAdminDashboardSummary(input);
  const excludeCustomerId = input.excludeCustomerId ?? null;

  const [revenueRows, complaintRows, inFlightGroups, humanHandledRows] =
    await Promise.all([
      prisma.$queryRaw<Array<{ revenue: string | null }>>(
        Prisma.sql`
          SELECT COALESCE(SUM(o.total_amount), 0)::text AS revenue
          FROM orders o
          WHERE o.business_id = ${input.businessId}::uuid
            AND ((o.created_at AT TIME ZONE ${input.tz})::date
                 BETWEEN ${input.from}::date AND ${input.to}::date)
            AND o.status <> ${OrderStatus.draft}::"OrderStatus"
            AND o.status <> ${OrderStatus.cancelled}::"OrderStatus"
        `
      ),
      prisma.$queryRaw<ComplaintRow[]>(
        excludeCustomerId
          ? Prisma.sql`
              SELECT c.id, c.ai_sentiment AS sentiment, c.ai_sentiment_updated_at AS updated_at,
                     cu.name AS customer_name
              FROM conversation c
              JOIN customer cu ON cu.id = c.customer_id
              WHERE c.business_id = ${input.businessId}::uuid
                AND c.ai_sentiment IN (${Prisma.join(COMPLAINT_SENTIMENTS)})
                AND c.ai_sentiment_updated_at IS NOT NULL
                AND ((c.ai_sentiment_updated_at AT TIME ZONE ${input.tz})::date
                     BETWEEN ${input.from}::date AND ${input.to}::date)
                AND c.customer_id <> ${excludeCustomerId}::uuid
              ORDER BY c.ai_sentiment_updated_at DESC
              LIMIT 8
            `
          : Prisma.sql`
              SELECT c.id, c.ai_sentiment AS sentiment, c.ai_sentiment_updated_at AS updated_at,
                     cu.name AS customer_name
              FROM conversation c
              JOIN customer cu ON cu.id = c.customer_id
              WHERE c.business_id = ${input.businessId}::uuid
                AND c.ai_sentiment IN (${Prisma.join(COMPLAINT_SENTIMENTS)})
                AND c.ai_sentiment_updated_at IS NOT NULL
                AND ((c.ai_sentiment_updated_at AT TIME ZONE ${input.tz})::date
                     BETWEEN ${input.from}::date AND ${input.to}::date)
              ORDER BY c.ai_sentiment_updated_at DESC
              LIMIT 8
            `
      ),
      prisma.orders.groupBy({
        by: ['status'],
        where: {
          business_id: input.businessId,
          status: { in: IN_FLIGHT_ORDER_STATUSES },
        },
        _count: { _all: true },
      }),
      prisma.$queryRaw<Array<{ count: bigint }>>(
        excludeCustomerId
          ? Prisma.sql`
              SELECT COUNT(*)::bigint AS count
              FROM conversation c
              JOIN conversation_state cs ON cs.conversation_id = c.id
              WHERE c.business_id = ${input.businessId}::uuid
                AND c.status = 'open'
                AND cs.is_human_handled = true
                AND c.customer_id <> ${excludeCustomerId}::uuid
            `
          : Prisma.sql`
              SELECT COUNT(*)::bigint AS count
              FROM conversation c
              JOIN conversation_state cs ON cs.conversation_id = c.id
              WHERE c.business_id = ${input.businessId}::uuid
                AND c.status = 'open'
                AND cs.is_human_handled = true
            `
      ),
    ]);

  const inFlightCounts = Object.fromEntries(
    inFlightGroups.map((row) => [row.status, row._count._all])
  );
  let inFlightTotal = 0;
  const inFlightLabeled = Object.fromEntries(
    IN_FLIGHT_ORDER_STATUSES.map((status) => {
      const count = inFlightCounts[status] ?? 0;
      inFlightTotal += count;
      return [status, { count, label: ORDER_STATUS_LABEL_ES[status] }];
    })
  );

  const complaints = complaintRows.map((row) => ({
    sentiment: row.sentiment,
    customerName: row.customer_name,
    updatedAt: row.updated_at?.toISOString() ?? null,
  }));

  const cancelled = dashboard.orders.byStatus.cancelled;
  const unpaid = dashboard.orders.byPaymentStatus.unpaid;
  const humanHandledNow = Number(humanHandledRows[0]?.count ?? 0);
  const revenue = revenueRows[0]?.revenue != null ? parseFloat(revenueRows[0].revenue) : 0;

  return {
    period: dashboard.period,
    previousPeriod: dashboard.previousPeriod,
    headlineHints: {
      orders: dashboard.orders.total,
      cancelled,
      complaints: complaints.length,
      inFlightNow: inFlightTotal,
      reservationsActive: dashboard.reservations.active,
      unpaid,
      humanHandledNow,
    },
    orders: {
      ...dashboard.orders,
      revenue,
      statusLabels: ORDER_STATUS_LABEL_ES,
    },
    reservations: dashboard.reservations,
    inFlightNow: {
      total: inFlightTotal,
      byStatus: inFlightLabeled,
      fulfillmentLabels: FULFILLMENT_LABEL_ES,
    },
    attention: {
      complaints,
      humanHandledOpen: humanHandledNow,
    },
  };
}
