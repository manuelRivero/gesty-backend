import type { reservation } from '@prisma/client';
import { RESERVATION_OCCUPYING_STATUSES } from '../constants/reservation';
import { prisma } from '../lib/prisma';
import {
  emitAdminReservationCancelled,
  emitAdminReservationCreated
} from '../socket/adminSocket';

export type ReservationSlotRecord = {
  id: string;
  start_time: string;
  end_time: string;
  is_active: boolean | null;
};

function normalizeTimeFromDb(time: string | Date): string {
  if (time instanceof Date) {
    return `${String(time.getUTCHours()).padStart(2, '0')}:${String(
      time.getUTCMinutes()
    ).padStart(2, '0')}`;
  }
  const value = String(time).trim();
  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) {
    return `${String(asDate.getUTCHours()).padStart(2, '0')}:${String(
      asDate.getUTCMinutes()
    ).padStart(2, '0')}`;
  }
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    throw new Error('INVALID_TIME');
  }
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

export async function fetchReservationSlotsForBusinessDate(
  businessId: string,
  date: Date
): Promise<ReservationSlotRecord[]> {
  const jsDay = date.getDay();
  const altDay = jsDay === 0 ? 7 : jsDay;
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      start_time: string | Date;
      end_time: string | Date;
      is_active: boolean | null;
    }>
  >`
    SELECT id, start_time, end_time, is_active
    FROM reservation_slot
    WHERE business_id = ${businessId}::uuid
      AND day_of_week IN (${jsDay}, ${altDay})
      AND (is_active = true OR is_active IS NULL)
    ORDER BY start_time ASC
  `;
  return rows.map((row) => ({
    id: row.id,
    start_time: normalizeTimeFromDb(row.start_time),
    end_time: normalizeTimeFromDb(row.end_time),
    is_active: row.is_active
  }));
}

/** Slot activo por id y negocio (misma consulta que el flujo WhatsApp). */
export async function fetchActiveReservationSlotById(
  slotId: string,
  businessId: string
): Promise<ReservationSlotRecord | null> {
  const slots = await prisma.$queryRaw<
    Array<{
      id: string;
      start_time: string | Date;
      end_time: string | Date;
      is_active: boolean | null;
    }>
  >`
    SELECT id, start_time, end_time, is_active
    FROM reservation_slot
    WHERE id = ${slotId}::uuid
      AND business_id = ${businessId}::uuid
      AND is_active = true
    LIMIT 1
  `;
  const row = slots[0];
  if (!row) return null;
  return {
    id: row.id,
    start_time: normalizeTimeFromDb(row.start_time),
    end_time: normalizeTimeFromDb(row.end_time),
    is_active: row.is_active
  };
}

export async function findActiveTablesByBusinessAndEnvironment(
  businessId: string,
  environmentId?: string
) {
  return prisma.table.findMany({
    where: {
      business_id: businessId,
      is_active: true,
      ...(environmentId && { environment_id: environmentId })
    },
    orderBy: { capacity: 'asc' }
  });
}

export async function findOverlappingReservationForTable(
  tableId: string,
  reservationDate: Date,
  startDateTime: Date
) {
  return prisma.reservation_table.findFirst({
    where: {
      table_id: tableId,
      reservation: {
        reservation_date: reservationDate,
        status: { in: [...RESERVATION_OCCUPYING_STATUSES] },
        start_time: startDateTime
      }
    },
    include: { reservation: true }
  });
}

export async function findReservationBlockAtStart(
  tableId: string,
  environmentId: string | null,
  reservationDate: Date,
  startDateTime: Date
) {
  return prisma.reservation_block.findFirst({
    where: {
      date: reservationDate,
      OR: [{ table_id: tableId }, { environment_id: environmentId }],
      AND: [{ start_time: { equals: startDateTime } }]
    }
  });
}

export async function createReservationWithTables(input: {
  businessId: string;
  customerId: string;
  conversationId?: string;
  partySize: number;
  reservationDate: Date;
  startDateTime: Date;
  endDateTime: Date;
  tableIds: string[];
}): Promise<reservation> {
  const created = await prisma.$transaction(async (tx) => {
    const conflict = await tx.reservation_table.findFirst({
      where: {
        table_id: { in: input.tableIds },
        reservation: {
          reservation_date: input.reservationDate,
          status: { in: [...RESERVATION_OCCUPYING_STATUSES] },
          AND: [
            { start_time: { lt: input.endDateTime } },
            { end_time: { gt: input.startDateTime } }
          ]
        }
      }
    });

    if (conflict) {
      throw new Error('TABLES_ALREADY_BOOKED');
    }

    const row = await tx.reservation.create({
      data: {
        business: { connect: { id: input.businessId } },
        customer: { connect: { id: input.customerId } },
        ...(input.conversationId
          ? { conversation: { connect: { id: input.conversationId } } }
          : {}),
        party_size: input.partySize,
        reservation_date: input.reservationDate,
        start_time: input.startDateTime,
        end_time: input.endDateTime,
        status: 'confirmed'
      }
    });

    await tx.reservation_table.createMany({
      data: input.tableIds.map((tableId) => ({
        reservation_id: row.id,
        table_id: tableId
      }))
    });

    return row;
  });

  console.log(
    `[Reservation][repo] reserva persistida id=${created.id} business_id=${created.business_id} — llamando emitAdminReservationCreated`
  );
  emitAdminReservationCreated(created.business_id, {
    reservationId: created.id
  });

  return created;
}

export async function findLatestOccupyingReservationWithTablesForCustomer(
  customerId: string
) {
  return prisma.reservation.findFirst({
    where: {
      customer_id: customerId,
      status: { in: [...RESERVATION_OCCUPYING_STATUSES] }
    },
    orderBy: [{ reservation_date: 'desc' }, { start_time: 'desc' }],
    include: { reservation_table: { include: { table: true } } }
  });
}

export async function findReservationByIdForCustomer(
  reservationId: string,
  customerId: string
) {
  return prisma.reservation.findFirst({
    where: { id: reservationId, customer_id: customerId }
  });
}

export async function findLatestOccupyingReservationForCustomer(
  customerId: string
) {
  return prisma.reservation.findFirst({
    where: {
      customer_id: customerId,
      status: { in: [...RESERVATION_OCCUPYING_STATUSES] }
    },
    orderBy: [{ reservation_date: 'desc' }, { start_time: 'desc' }]
  });
}

export async function findFutureOccupyingReservationForCustomerOrdered(
  customerId: string,
  fromDateStartOfDay: Date
) {
  return prisma.reservation.findFirst({
    where: {
      customer_id: customerId,
      status: { in: [...RESERVATION_OCCUPYING_STATUSES] },
      reservation_date: { gte: fromDateStartOfDay }
    },
    orderBy: [{ reservation_date: 'desc' }, { start_time: 'desc' }]
  });
}

export async function findAnyFutureOccupyingReservationForCustomer(
  customerId: string,
  fromDateStartOfDay: Date
) {
  return prisma.reservation.findFirst({
    where: {
      customer_id: customerId,
      status: { in: [...RESERVATION_OCCUPYING_STATUSES] },
      reservation_date: { gte: fromDateStartOfDay }
    }
  });
}

export async function updateReservationStatus(
  reservationId: string,
  status: reservation['status']
) {
  const row = await prisma.reservation.update({
    where: { id: reservationId },
    data: { status }
  });
  if (status === 'closed') {
    emitAdminReservationCancelled(row.business_id, {
      reservationId: row.id,
      status: 'closed'
    });
  }
  return row;
}

export async function findActiveEnvironmentsByBusinessId(businessId: string) {
  return prisma.environment.findMany({
    where: { business_id: businessId, is_active: true },
    orderBy: { name: 'asc' }
  });
}

export async function findEnvironmentNameById(environmentId: string) {
  const env = await prisma.environment.findUnique({
    where: { id: environmentId }
  });
  return env?.name ?? null;
}
