/**
 * Reloj único del flujo de reservas.
 *
 * Todo "ahora" sale de acá, en la zona IANA del local (`business.timezone`).
 * `reservationNow(timezone)` devuelve un Date de reloj de pared: getFullYear /
 * getDate / getDay / getHours son el día y la hora de esa zona, aunque el
 * proceso corra en UTC.
 *
 * Si el dato falta o no es una zona IANA, se usa
 * `RESERVATION_TIMEZONE_FALLBACK` (el default de la columna en la DB).
 */

export const DAY_NAMES_ES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

export type WeekdayEs = (typeof DAY_NAMES_ES)[number];

/** Default de `business.timezone` para filas viejas o un valor vacío. */
export const RESERVATION_TIMEZONE_FALLBACK = 'America/Argentina/Buenos_Aires';

export function coerceIanaTimezone(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return RESERVATION_TIMEZONE_FALLBACK;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: trimmed });
    return trimmed;
  } catch {
    return RESERVATION_TIMEZONE_FALLBACK;
  }
}

function zonedParts(
  instant: Date,
  timezone: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const zone = coerceIanaTimezone(timezone);
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = formatter.formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const hourRaw = pick('hour');
  return {
    year: Number(pick('year')),
    month: Number(pick('month')),
    day: Number(pick('day')),
    hour: hourRaw === '24' ? 0 : Number(hourRaw),
    minute: Number(pick('minute')),
    second: Number(pick('second')),
  };
}

/** Reloj de pared de `timezone`. No es el instante UTC. */
export function reservationNow(timezone: string): Date {
  const parts = zonedParts(new Date(), timezone);
  return new Date(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
}

/** Medianoche del día en curso en `timezone` — el límite de "fecha pasada". */
export function reservationToday(timezone: string): Date {
  return startOfDay(reservationNow(timezone));
}

/** Copia de `date` a las 00:00 (no muta el argumento). */
export function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

/** Nombre del día de la semana en español, en minúscula y con tilde. */
export function weekdayNameEs(date: Date): WeekdayEs {
  return DAY_NAMES_ES[date.getDay()];
}

/** `DD/MM/AAAA` — el formato que hablan las tools, el borrador y el ledger. */
export function formatDMY(date: Date): string {
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}/${month}/${date.getFullYear()}`;
}

/** `30/08/2026 (domingo)` — la línea de fecha actual del ledger. */
export function currentDateLabel(timezone: string): string {
  const now = reservationNow(timezone);
  return `${formatDMY(now)} (${weekdayNameEs(now)})`;
}

/**
 * Etiqueta de una fecha de borrador `DD/MM/AAAA` con weekday del calendario.
 * `timezone` solo entra si el string no trae año.
 */
export function formatDraftDateWithWeekday(dmy: string, timezone?: string): string {
  const parts = dmy.trim().split('/');
  if (parts.length < 2) return dmy;
  const day = Number(parts[0]);
  const month = Number(parts[1]) - 1;
  const year =
    parts[2] !== undefined
      ? Number(parts[2])
      : reservationNow(coerceIanaTimezone(timezone)).getFullYear();
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) {
    return dmy;
  }
  const date = new Date(year, month, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month ||
    date.getDate() !== day
  ) {
    return dmy;
  }
  return `${formatDMY(date)} (${weekdayNameEs(date)})`;
}

/**
 * Próxima fecha (desde hoy en `timezone`, excluyéndolo) que cae en `weekday`.
 */
export function nextDateForWeekday(weekday: WeekdayEs, timezone: string): Date {
  const target = DAY_NAMES_ES.indexOf(weekday);
  const date = reservationToday(timezone);
  let diff = target - date.getDay();
  if (diff <= 0) diff += 7;
  date.setDate(date.getDate() + diff);
  return date;
}
