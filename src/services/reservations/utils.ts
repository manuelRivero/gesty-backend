import { fetchReservationSlotsForBusinessDate } from '../../repositories/reservation.repository';
import { reservationNow } from './clock';
import type {
  EnvironmentPreferenceRow,
  ReservationSlot,
} from './types';

const toMinutes = (value: string): number => {
  const [hh, mm] = value.split(':').map(Number);
  return (hh || 0) * 60 + (mm || 0);
};

function buildTurnIndexMap(slots: ReservationSlot[]): Map<string, number> {
  const ordered = [...slots].sort(
    (a, b) => toMinutes(a.start_time) - toMinutes(b.start_time)
  );
  const map = new Map<string, number>();
  let currentTurn = 0;
  let previousEnd: number | null = null;
  for (const slot of ordered) {
    const start = toMinutes(slot.start_time);
    const end = toMinutes(slot.end_time);
    if (previousEnd !== null && start > previousEnd) {
      currentTurn += 1;
    }
    map.set(slot.id, currentTurn);
    previousEnd = end;
  }
  return map;
}

function getCurrentTurnIndex(
  slots: ReservationSlot[],
  now: Date
): number | null {
  const current = toMinutes(
    `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes()
    ).padStart(2, '0')}`
  );
  const turnMap = buildTurnIndexMap(slots);
  for (const slot of slots) {
    const start = toMinutes(slot.start_time);
    const end = toMinutes(slot.end_time);
    if (current >= start && current < end) {
      return turnMap.get(slot.id) ?? null;
    }
  }
  return null;
}

export function filterSlotsByTurnLead(
  slots: ReservationSlot[],
  date: Date,
  now: Date
): ReservationSlot[] {
  const isSameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (!isSameDay) return slots;

  const turnMap = buildTurnIndexMap(slots);
  const currentTurn = getCurrentTurnIndex(slots, now);

  if (currentTurn === null) {
    const currentMinutes = toMinutes(
      `${String(now.getHours()).padStart(2, '0')}:${String(
        now.getMinutes()
      ).padStart(2, '0')}`
    );
    return slots.filter((slot) => toMinutes(slot.start_time) > currentMinutes);
  }

  return slots.filter((slot) => (turnMap.get(slot.id) ?? -1) > currentTurn);
}

export function normalizeDate(dateStr: string): Date {
  const parts = dateStr.split('/');

  if (parts.length < 2) {
    throw new Error('INVALID_DATE_FORMAT');
  }

  const day = Number(parts[0]);
  const month = Number(parts[1]) - 1;

  const year =
    parts[2] !== undefined ? Number(parts[2]) : reservationNow().getFullYear();

  const date = new Date(year, month, day);

  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    throw new Error('INVALID_DATE');
  }

  if (isNaN(date.getTime())) {
    throw new Error('INVALID_DATE');
  }

  return date;
}

export function normalizeTimeInput(time: string | Date): string {
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

export function buildDateTime(date: Date, time: string | Date): Date {
  const normalized = normalizeTimeInput(time);
  const [hours, minutes] = normalized.split(':').map(Number);

  const result = new Date(date);
  result.setHours(hours, minutes, 0, 0);

  return result;
}

export async function getReservationSlotsForBusinessDate(
  businessId: string,
  date: Date
): Promise<ReservationSlot[]> {
  return fetchReservationSlotsForBusinessDate(businessId, date);
}

export function formatDateExample(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}`;
}

export async function getFirstAvailableTimeForDate(
  businessId: string,
  date: Date,
  now: Date
): Promise<string | null> {
  const slots = await getReservationSlotsForBusinessDate(businessId, date);
  if (!slots.length) return null;
  const eligible = filterSlotsByTurnLead(slots, date, now);
  for (const slot of eligible) {
    return slot.start_time;
  }

  return null;
}

export async function getNextDateExample(
  businessId: string
): Promise<string> {
  const now = reservationNow();
  for (let offset = 0; offset < 30; offset += 1) {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + offset);
    const time = await getFirstAvailableTimeForDate(businessId, date, now);
    if (time) return formatDateExample(date);
  }
  const fallback = new Date(now);
  fallback.setDate(fallback.getDate() + 1);
  return formatDateExample(fallback);
}

export function formatReservationDateDb(d: Date): string {
  const day = d.getUTCDate();
  const month = d.getUTCMonth() + 1;
  const year = d.getUTCFullYear();
  return `${String(day).padStart(2, '0')}/${String(month).padStart(
    2,
    '0'
  )}/${year}`;
}

export function formatDbTimeReservation(d: Date): string {
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function formatDisplayTime(value?: string): string {
  if (!value) return '-';
  try {
    return normalizeTimeInput(value);
  } catch {
    return value;
  }
}

export function reservationStatusLabel(status: string): string {
  switch (status) {
    case 'confirmed':
      return 'Confirmada';
    case 'partial':
      return 'Parcial';
    case 'completed':
      return 'Completada';
    case 'closed':
      return 'Cerrada';
    default:
      return status;
  }
}

export function mapEnvironmentToId(
  input: string,
  environments: EnvironmentPreferenceRow[]
): string | null {
  const text = input.toLowerCase();

  if (text.includes('interior') || text.includes('adentro')) {
    return environments.find((e) => !e.is_outdoor)?.id || null;
  }

  if (text.includes('exterior') || text.includes('afuera')) {
    return environments.find((e) => e.is_outdoor)?.id || null;
  }

  return null;
}

export function selectTables(
  tables: { id: string; capacity: number }[],
  partySize: number
): { id: string; capacity: number }[] | null {
  const sorted = [...tables].sort((a, b) => a.capacity - b.capacity);
  const exact = sorted.find((table) => table.capacity === partySize);
  if (exact) return [exact];

  const selected: { id: string; capacity: number }[] = [];
  let total = 0;
  for (const table of sorted) {
    selected.push(table);
    total += table.capacity;
    if (total >= partySize) return selected;
  }
  return null;
}
