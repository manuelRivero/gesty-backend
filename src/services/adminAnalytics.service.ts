import { OrderStatus, Prisma } from "@prisma/client";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { prisma } from "../lib/prisma";

dayjs.extend(utc);

export type AnalyticsPeriodInput = {
  businessId: string;
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
  tz: string;
};

// ─── Order Volume ────────────────────────────────────────────────────────────

export async function getOrderVolume(input: AnalyticsPeriodInput) {
  // Build the full date spine in the requested range
  const allDates: string[] = [];
  let cur = dayjs.utc(input.from);
  const end = dayjs.utc(input.to);
  while (!cur.isAfter(end)) {
    allDates.push(cur.format("YYYY-MM-DD"));
    cur = cur.add(1, "day");
  }

  const rows = await prisma.$queryRaw<Array<{ date: string; units: bigint; revenue: string | null }>>(
    Prisma.sql`
      SELECT
        d.date,
        COUNT(*)::bigint      AS units,
        SUM(d.total_amount)::text AS revenue
      FROM (
        SELECT
          (o.created_at AT TIME ZONE ${input.tz})::date::text AS date,
          o.total_amount
        FROM orders o
        WHERE o.business_id = ${input.businessId}::uuid
          AND (o.created_at AT TIME ZONE ${input.tz})::date
                BETWEEN ${input.from}::date AND ${input.to}::date
          AND o.status <> ${OrderStatus.draft}::"OrderStatus"
      ) d
      GROUP BY d.date
    `
  );

  const byDate = new Map(rows.map((r) => [r.date, r]));

  const data = allDates.map((date) => {
    const row = byDate.get(date);
    return {
      date,
      units: row ? Number(row.units) : 0,
      revenue: row?.revenue != null ? parseFloat(row.revenue) : 0,
    };
  });

  return {
    period: { from: input.from, to: input.to, tz: input.tz },
    data,
  };
}

// ─── Client Ranking ──────────────────────────────────────────────────────────

export async function getClientRanking(input: AnalyticsPeriodInput & { limit: number }) {
  const rows = await prisma.$queryRaw<
    Array<{
      customer_id: string;
      name: string | null;
      phone: string;
      order_count: bigint;
      total_spend: string | null;
      last_order_date: string;
    }>
  >(
    Prisma.sql`
      SELECT
        c.id                                                              AS customer_id,
        c.name,
        c.phone_number                                                    AS phone,
        COUNT(o.id)::bigint                                               AS order_count,
        SUM(o.total_amount)::text                                         AS total_spend,
        MAX((o.created_at AT TIME ZONE ${input.tz})::date)::text          AS last_order_date
      FROM orders o
      JOIN customer c ON c.id = o.customer_id
      WHERE o.business_id = ${input.businessId}::uuid
        AND (o.created_at AT TIME ZONE ${input.tz})::date
              BETWEEN ${input.from}::date AND ${input.to}::date
        AND o.status <> ${OrderStatus.draft}::"OrderStatus"
      GROUP BY c.id, c.name, c.phone_number
      ORDER BY COUNT(o.id) DESC
      LIMIT ${input.limit}
    `
  );

  const data = rows.map((r) => {
    const orderCount = Number(r.order_count);
    const totalSpend = r.total_spend != null ? parseFloat(r.total_spend) : 0;
    return {
      customer_id: r.customer_id,
      name: r.name ?? null,
      phone: r.phone,
      order_count: orderCount,
      total_spend: totalSpend,
      avg_order_value: orderCount > 0 ? Math.round((totalSpend / orderCount) * 100) / 100 : 0,
      last_order_date: r.last_order_date,
    };
  });

  return {
    period: { from: input.from, to: input.to, tz: input.tz },
    data,
  };
}

// ─── Top Dishes ──────────────────────────────────────────────────────────────

export async function getTopDishes(input: AnalyticsPeriodInput & { limit: number }) {
  const rows = await prisma.$queryRaw<
    Array<{
      menu_item_id: string;
      name: string;
      order_count: bigint;
      revenue: string | null;
    }>
  >(
    Prisma.sql`
      SELECT
        oi.menu_item_id::text                          AS menu_item_id,
        mi.name,
        SUM(oi.quantity)::bigint                       AS order_count,
        SUM(oi.quantity * oi.unit_price)::text         AS revenue
      FROM order_item oi
      JOIN orders     o  ON o.id  = oi.order_id
      JOIN menu_item  mi ON mi.id = oi.menu_item_id
      WHERE o.business_id = ${input.businessId}::uuid
        AND (o.created_at AT TIME ZONE ${input.tz})::date
              BETWEEN ${input.from}::date AND ${input.to}::date
        AND o.status <> ${OrderStatus.draft}::"OrderStatus"
      GROUP BY oi.menu_item_id, mi.name
      ORDER BY SUM(oi.quantity) DESC
      LIMIT ${input.limit}
    `
  );

  const data = rows.map((r) => ({
    menu_item_id: r.menu_item_id,
    name: r.name,
    order_count: Number(r.order_count),
    revenue: r.revenue != null ? parseFloat(r.revenue) : 0,
  }));

  return {
    period: { from: input.from, to: input.to, tz: input.tz },
    data,
  };
}
