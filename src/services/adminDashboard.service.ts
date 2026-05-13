import { OrderPaymentStatus, OrderStatus, Prisma } from "@prisma/client";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { RESERVATION_OCCUPYING_STATUSES } from "../constants/reservation";
import { prisma } from "../lib/prisma";

dayjs.extend(utc);

export type DashboardPeriodInput = {
  businessId: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  tz: string;
};

type GroupRow = { key: string; count: number };

function calcDeltaPct(current: number, previous: number): number {
  if (previous === 0) {
    return current === 0 ? 0 : 100;
  }
  return Math.round(((current - previous) / previous) * 100);
}

function previousEquivalentPeriod(from: string, to: string): { from: string; to: string } {
  const start = dayjs.utc(from, "YYYY-MM-DD", true);
  const end = dayjs.utc(to, "YYYY-MM-DD", true);
  const days = end.diff(start, "day") + 1;
  const prevEnd = start.subtract(1, "day");
  const prevStart = prevEnd.subtract(days - 1, "day");
  return {
    from: prevStart.format("YYYY-MM-DD"),
    to: prevEnd.format("YYYY-MM-DD")
  };
}

function withAllOrderStatuses(rows: GroupRow[]): Record<OrderStatus, number> {
  const base: Record<OrderStatus, number> = {
    draft: 0,
    placed: 0,
    preparing: 0,
    ready_for_pickup: 0,
    shipped: 0,
    delivered: 0,
    cancelled: 0
  };
  for (const row of rows) {
    if (row.key in base) {
      base[row.key as OrderStatus] = Number(row.count) || 0;
    }
  }
  return base;
}

function withAllOrderPaymentStatuses(rows: GroupRow[]): Record<OrderPaymentStatus, number> {
  const base: Record<OrderPaymentStatus, number> = {
    unpaid: 0,
    paid: 0
  };
  for (const row of rows) {
    if (row.key in base) {
      base[row.key as OrderPaymentStatus] = Number(row.count) || 0;
    }
  }
  return base;
}

function mapReservationStatusRows(rows: GroupRow[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[row.key] = Number(row.count) || 0;
    return acc;
  }, {});
}

export async function getAdminDashboardSummary(input: DashboardPeriodInput) {
  const previous = previousEquivalentPeriod(input.from, input.to);

  // Total pedidos del período (excluye borradores)
  const ordersCurrentRows = await prisma.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM orders o
      WHERE o.business_id = ${input.businessId}::uuid
        AND ((o.created_at AT TIME ZONE ${input.tz})::date BETWEEN ${input.from}::date AND ${input.to}::date)
        AND o.status <> ${OrderStatus.draft}::"OrderStatus"
    `
  );
  const ordersPreviousRows = await prisma.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM orders o
      WHERE o.business_id = ${input.businessId}::uuid
        AND ((o.created_at AT TIME ZONE ${input.tz})::date BETWEEN ${previous.from}::date AND ${previous.to}::date)
        AND o.status <> ${OrderStatus.draft}::"OrderStatus"
    `
  );

  const ordersByStatusRows = await prisma.$queryRaw<Array<{ key: string; count: number }>>(
    Prisma.sql`
      SELECT o.status::text AS key, COUNT(*)::int AS count
      FROM orders o
      WHERE o.business_id = ${input.businessId}::uuid
        AND ((o.created_at AT TIME ZONE ${input.tz})::date BETWEEN ${input.from}::date AND ${input.to}::date)
      GROUP BY o.status
    `
  );

  const ordersByPaymentRows = await prisma.$queryRaw<Array<{ key: string; count: number }>>(
    Prisma.sql`
      SELECT o.payment_status::text AS key, COUNT(*)::int AS count
      FROM orders o
      WHERE o.business_id = ${input.businessId}::uuid
        AND ((o.created_at AT TIME ZONE ${input.tz})::date BETWEEN ${input.from}::date AND ${input.to}::date)
      GROUP BY o.payment_status
    `
  );

  // Reservas activas del período (según ocupación real)
  const reservationsCurrentRows = await prisma.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM reservation r
      WHERE r.business_id = ${input.businessId}::uuid
        AND (r.reservation_date BETWEEN ${input.from}::date AND ${input.to}::date)
        AND r.status = ANY(ARRAY[${Prisma.join(RESERVATION_OCCUPYING_STATUSES)}]::text[])
    `
  );
  const reservationsPreviousRows = await prisma.$queryRaw<Array<{ count: bigint }>>(
    Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM reservation r
      WHERE r.business_id = ${input.businessId}::uuid
        AND (r.reservation_date BETWEEN ${previous.from}::date AND ${previous.to}::date)
        AND r.status = ANY(ARRAY[${Prisma.join(RESERVATION_OCCUPYING_STATUSES)}]::text[])
    `
  );
  const reservationsByStatusRows = await prisma.$queryRaw<Array<{ key: string; count: number }>>(
    Prisma.sql`
      SELECT COALESCE(r.status, 'unknown') AS key, COUNT(*)::int AS count
      FROM reservation r
      WHERE r.business_id = ${input.businessId}::uuid
        AND (r.reservation_date BETWEEN ${input.from}::date AND ${input.to}::date)
      GROUP BY COALESCE(r.status, 'unknown')
    `
  );

  const ordersCurrent = Number(ordersCurrentRows[0]?.count ?? 0);
  const ordersPrevious = Number(ordersPreviousRows[0]?.count ?? 0);
  const reservationsCurrent = Number(reservationsCurrentRows[0]?.count ?? 0);
  const reservationsPrevious = Number(reservationsPreviousRows[0]?.count ?? 0);

  return {
    period: {
      from: input.from,
      to: input.to,
      tz: input.tz
    },
    previousPeriod: previous,
    definitions: {
      orderTotalExcludes: [OrderStatus.draft],
      activeReservationStatuses: [...RESERVATION_OCCUPYING_STATUSES]
    },
    orders: {
      total: ordersCurrent,
      deltaPct: calcDeltaPct(ordersCurrent, ordersPrevious),
      byStatus: withAllOrderStatuses(ordersByStatusRows),
      byPaymentStatus: withAllOrderPaymentStatuses(ordersByPaymentRows)
    },
    reservations: {
      active: reservationsCurrent,
      deltaPct: calcDeltaPct(reservationsCurrent, reservationsPrevious),
      byStatus: mapReservationStatusRows(reservationsByStatusRows)
    }
  };
}
