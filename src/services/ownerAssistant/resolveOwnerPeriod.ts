/**
 * Resuelve el período de métricas en el timezone del negocio.
 * Presets, no interpretación de prosa: el LLM elige el preset; las fechas
 * las calcula el código (misma idea que ceil(party/serves)).
 */

export type OwnerPeriodPreset = 'today' | 'yesterday' | 'this_week' | 'custom';

export type OwnerPeriod = {
  from: string;
  to: string;
  preset: OwnerPeriodPreset;
};

export type OwnerPeriodError = {
  error: 'period_required';
  missing: 'period';
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD del calendario en `tz`. `en-CA` produce ISO. */
export const calendarDateInTz = (tz: string, now: Date = new Date()): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(now);
  }
};

export const shiftCalendarDate = (isoDate: string, days: number): string => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  utcNoon.setUTCDate(utcNoon.getUTCDate() + days);
  return utcNoon.toISOString().slice(0, 10);
};

/** Lunes de la semana ISO de `isoDate` (domingo → lunes anterior). */
export const mondayOf = (isoDate: string): string => {
  const [y, m, d] = isoDate.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const dow = utcNoon.getUTCDay();
  const mondayOffset = dow === 0 ? 6 : dow - 1;
  utcNoon.setUTCDate(utcNoon.getUTCDate() - mondayOffset);
  return utcNoon.toISOString().slice(0, 10);
};

export const resolveOwnerPeriod = (input: {
  period: OwnerPeriodPreset;
  from?: string;
  to?: string;
  tz: string;
  now?: Date;
}): OwnerPeriod | OwnerPeriodError => {
  const today = calendarDateInTz(input.tz, input.now);

  if (input.period === 'today') {
    return { from: today, to: today, preset: 'today' };
  }
  if (input.period === 'yesterday') {
    const yesterday = shiftCalendarDate(today, -1);
    return { from: yesterday, to: yesterday, preset: 'yesterday' };
  }
  if (input.period === 'this_week') {
    return { from: mondayOf(today), to: today, preset: 'this_week' };
  }

  const from = input.from?.trim() ?? '';
  const to = input.to?.trim() ?? '';
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    return { error: 'period_required', missing: 'period' };
  }
  return { from, to, preset: 'custom' };
};
