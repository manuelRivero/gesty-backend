import { prisma } from "../lib/prisma";

type ReservationSlotRow = {
  id: string;
  business_id: string;
  day_of_week: number;
  start_time: Date;
  end_time: Date;
  capacity_limit: number | null;
  is_active: boolean | null;
  created_at: Date | null;
};

export type AdminReservationSlotDto = ReturnType<typeof mapReservationSlot>;

export type AdminReservationSlotMutationError =
  | "INVALID_TIME_RANGE"
  | "SLOTS_OVERLAP";

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function timeToMinutes(value: string): number {
  const match = HHMM_REGEX.exec(value.trim());
  if (!match) {
    throw new Error("INVALID_TIME");
  }
  return Number(match[1]) * 60 + Number(match[2]);
}

export function normalizeTimeFromDb(time: string | Date): string {
  if (time instanceof Date) {
    return `${String(time.getUTCHours()).padStart(2, "0")}:${String(
      time.getUTCMinutes()
    ).padStart(2, "0")}`;
  }
  const value = String(time).trim();
  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) {
    return `${String(asDate.getUTCHours()).padStart(2, "0")}:${String(
      asDate.getUTCMinutes()
    ).padStart(2, "0")}`;
  }
  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    throw new Error("INVALID_TIME");
  }
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

export function timeToPrismaDate(hhmm: string): Date {
  const minutes = timeToMinutes(hhmm);
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return new Date(Date.UTC(1970, 0, 1, hh, mm, 0));
}

/** Solapamiento estricto: [start, end); turnos contiguos no cuentan como solapados. */
export function reservationSlotsOverlap(
  startMinutes: number,
  endMinutes: number,
  otherStartMinutes: number,
  otherEndMinutes: number
): boolean {
  return startMinutes < otherEndMinutes && endMinutes > otherStartMinutes;
}

function mapReservationSlot(row: ReservationSlotRow) {
  return {
    id: row.id,
    businessId: row.business_id,
    dayOfWeek: row.day_of_week,
    startTime: normalizeTimeFromDb(row.start_time),
    endTime: normalizeTimeFromDb(row.end_time),
    capacityLimit: row.capacity_limit,
    isActive: row.is_active ?? true,
    createdAt: row.created_at
  };
}

async function findOverlappingSlot(params: {
  businessId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  excludeId?: string;
}): Promise<ReservationSlotRow | null> {
  const startMinutes = timeToMinutes(params.startTime);
  const endMinutes = timeToMinutes(params.endTime);

  const siblings = await prisma.reservation_slot.findMany({
    where: {
      business_id: params.businessId,
      day_of_week: params.dayOfWeek,
      ...(params.excludeId ? { id: { not: params.excludeId } } : {})
    }
  });

  for (const sibling of siblings) {
    const siblingStart = timeToMinutes(normalizeTimeFromDb(sibling.start_time));
    const siblingEnd = timeToMinutes(normalizeTimeFromDb(sibling.end_time));
    if (
      reservationSlotsOverlap(
        startMinutes,
        endMinutes,
        siblingStart,
        siblingEnd
      )
    ) {
      return sibling as ReservationSlotRow;
    }
  }

  return null;
}

function validateTimeRange(startTime: string, endTime: string): boolean {
  return timeToMinutes(startTime) < timeToMinutes(endTime);
}

export async function listAdminReservationSlots(params: { businessId: string }) {
  const rows = await prisma.reservation_slot.findMany({
    where: { business_id: params.businessId },
    orderBy: [{ day_of_week: "asc" }, { start_time: "asc" }, { created_at: "asc" }]
  });

  return rows.map((row) => mapReservationSlot(row as ReservationSlotRow));
}

export async function getAdminReservationSlotById(params: {
  businessId: string;
  id: string;
}): Promise<AdminReservationSlotDto | null> {
  const row = await prisma.reservation_slot.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    }
  });

  return row ? mapReservationSlot(row as ReservationSlotRow) : null;
}

export async function createAdminReservationSlot(params: {
  businessId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  capacityLimit?: number | null;
  isActive?: boolean;
}): Promise<
  AdminReservationSlotDto | AdminReservationSlotMutationError
> {
  if (!validateTimeRange(params.startTime, params.endTime)) {
    return "INVALID_TIME_RANGE";
  }

  const overlapping = await findOverlappingSlot({
    businessId: params.businessId,
    dayOfWeek: params.dayOfWeek,
    startTime: params.startTime,
    endTime: params.endTime
  });
  if (overlapping) {
    return "SLOTS_OVERLAP";
  }

  const row = await prisma.reservation_slot.create({
    data: {
      business_id: params.businessId,
      day_of_week: params.dayOfWeek,
      start_time: timeToPrismaDate(params.startTime),
      end_time: timeToPrismaDate(params.endTime),
      ...(params.capacityLimit !== undefined
        ? { capacity_limit: params.capacityLimit }
        : {}),
      is_active: params.isActive ?? true
    }
  });

  return mapReservationSlot(row as ReservationSlotRow);
}

export async function updateAdminReservationSlot(params: {
  businessId: string;
  id: string;
  dayOfWeek?: number;
  startTime?: string;
  endTime?: string;
  capacityLimit?: number | null;
  isActive?: boolean;
}): Promise<
  AdminReservationSlotDto | null | AdminReservationSlotMutationError
> {
  const existing = await prisma.reservation_slot.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    }
  });

  if (!existing) {
    return null;
  }

  const dayOfWeek = params.dayOfWeek ?? existing.day_of_week;
  const startTime =
    params.startTime ?? normalizeTimeFromDb(existing.start_time);
  const endTime = params.endTime ?? normalizeTimeFromDb(existing.end_time);

  if (!validateTimeRange(startTime, endTime)) {
    return "INVALID_TIME_RANGE";
  }

  const overlapping = await findOverlappingSlot({
    businessId: params.businessId,
    dayOfWeek,
    startTime,
    endTime,
    excludeId: params.id
  });
  if (overlapping) {
    return "SLOTS_OVERLAP";
  }

  const row = await prisma.reservation_slot.update({
    where: { id: params.id },
    data: {
      ...(params.dayOfWeek !== undefined ? { day_of_week: params.dayOfWeek } : {}),
      ...(params.startTime !== undefined
        ? { start_time: timeToPrismaDate(params.startTime) }
        : {}),
      ...(params.endTime !== undefined
        ? { end_time: timeToPrismaDate(params.endTime) }
        : {}),
      ...(params.capacityLimit !== undefined
        ? { capacity_limit: params.capacityLimit }
        : {}),
      ...(params.isActive !== undefined ? { is_active: params.isActive } : {})
    }
  });

  return mapReservationSlot(row as ReservationSlotRow);
}

export async function deleteAdminReservationSlot(params: {
  businessId: string;
  id: string;
}): Promise<{ id: string } | null> {
  const existing = await prisma.reservation_slot.findFirst({
    where: {
      id: params.id,
      business_id: params.businessId
    },
    select: { id: true }
  });

  if (!existing) {
    return null;
  }

  await prisma.reservation_slot.delete({
    where: { id: params.id }
  });

  return { id: params.id };
}
