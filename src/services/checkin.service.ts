import { prisma } from "../lib/prisma";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function timeToHHmm(value: Date): string {
  const h = value.getUTCHours();
  const m = value.getUTCMinutes();
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function deriveStatusFromArrivals(
  arrivedCount: number,
  partySize: number
): "confirmed" | "partial" | "completed" {
  if (arrivedCount <= 0) return "confirmed";
  if (arrivedCount < partySize) return "partial";
  return "completed";
}

export function isValidReservationToken(token: string): boolean {
  return UUID_RE.test(token);
}

export async function getCheckinPayload(token: string) {
  const reservation = await prisma.reservation.findFirst({
    where: { checkin_token: token },
    include: {
      reservation_table: {
        include: { table: true }
      }
    }
  });

  if (!reservation) return null;

  const arrived = reservation.arrived_count ?? 0;
  const partySize = reservation.party_size;
  const remaining = Math.max(0, partySize - arrived);

  return {
    partySize,
    arrived_count: arrived,
    remaining,
    status: reservation.status,
    tables: reservation.reservation_table.map((rt) => ({
      id: rt.table.id,
      name: rt.table.name
    })),
    time: {
      start: timeToHHmm(reservation.start_time),
      end: timeToHHmm(reservation.end_time)
    }
  };
}

export async function addArrivals(token: string, rawCount: unknown) {
  const count = Number(rawCount);
  if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) {
    throw new Error("INVALID_COUNT");
  }

  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findFirst({ where: { checkin_token: token } });
    if (!r) throw new Error("NOT_FOUND");
    if (r.status === "closed") throw new Error("CLOSED");

    const nextArrived = Math.min(r.party_size, (r.arrived_count ?? 0) + count);
    const nextStatus = deriveStatusFromArrivals(nextArrived, r.party_size);

    return tx.reservation.update({
      where: { id: r.id },
      data: {
        arrived_count: nextArrived,
        status: nextStatus
      }
    });
  });
}

export async function removeArrivals(token: string, rawCount: unknown) {
  const count = Number(rawCount);
  if (!Number.isFinite(count) || count <= 0 || !Number.isInteger(count)) {
    throw new Error("INVALID_COUNT");
  }

  return prisma.$transaction(async (tx) => {
    const r = await tx.reservation.findFirst({ where: { checkin_token: token } });
    if (!r) throw new Error("NOT_FOUND");
    if (r.status === "closed") throw new Error("CLOSED");

    const nextArrived = Math.max(0, (r.arrived_count ?? 0) - count);
    const nextStatus = deriveStatusFromArrivals(nextArrived, r.party_size);

    return tx.reservation.update({
      where: { id: r.id },
      data: {
        arrived_count: nextArrived,
        status: nextStatus
      }
    });
  });
}

export async function closeReservation(token: string) {
  const r = await prisma.reservation.findFirst({ where: { checkin_token: token } });
  if (!r) return null;

  return prisma.reservation.update({
    where: { id: r.id },
    data: { status: "closed" }
  });
}
