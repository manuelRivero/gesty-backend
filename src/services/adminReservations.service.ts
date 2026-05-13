import type { Prisma } from "@prisma/client";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc";
import { prisma } from "../lib/prisma";

dayjs.extend(utc);

const RESERVATION_INCLUDE = {
  customer: true,
  conversation: {
    select: {
      id: true,
      channel: true,
      status: true,
      started_at: true,
      last_message_at: true
    }
  },
  reservation_table: {
    include: {
      table: {
        include: {
          environment: true
        }
      }
    }
  }
} satisfies Prisma.reservationInclude;

function parseDateStart(s: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return dayjs.utc(s).startOf("day").toDate();
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error("INVALID_DATE_FROM");
  }
  return d;
}

function parseDateEnd(s: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return dayjs.utc(s).endOf("day").toDate();
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error("INVALID_DATE_TO");
  }
  return d;
}

export type ListAdminReservationsParams = {
  businessId: string;
  page: number;
  pageSize: number;
  reservationId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: string;
  customerPhone?: string;
};

export async function listAdminReservations(params: ListAdminReservationsParams) {
  const {
    businessId,
    page,
    pageSize,
    reservationId,
    dateFrom,
    dateTo,
    status,
    customerPhone
  } = params;

  const where: Prisma.reservationWhereInput = {
    business_id: businessId
  };

  if (reservationId) {
    where.id = reservationId;
  }

  if (status?.trim()) {
    where.status = status.trim();
  }

  if (customerPhone?.trim()) {
    where.customer = {
      phone_number: { contains: customerPhone.trim() }
    };
  }

  if (dateFrom || dateTo) {
    where.reservation_date = {};
    if (dateFrom) {
      where.reservation_date.gte = parseDateStart(dateFrom);
    }
    if (dateTo) {
      where.reservation_date.lte = parseDateEnd(dateTo);
    }
  }

  const skip = (page - 1) * pageSize;

  const [total, rows] = await prisma.$transaction([
    prisma.reservation.count({ where }),
    prisma.reservation.findMany({
      where,
      include: RESERVATION_INCLUDE,
      orderBy: [{ reservation_date: "desc" }, { start_time: "desc" }],
      skip,
      take: pageSize
    })
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  return {
    items: rows,
    total,
    page,
    pageSize,
    totalPages
  };
}

export async function getAdminReservationById(
  businessId: string,
  reservationId: string
) {
  return prisma.reservation.findFirst({
    where: {
      id: reservationId,
      business_id: businessId
    },
    include: RESERVATION_INCLUDE
  });
}
