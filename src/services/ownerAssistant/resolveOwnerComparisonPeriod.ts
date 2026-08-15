/**
 * Resuelve ventanas [startAt, endAt) para métricas Owner V1.
 * Política: equivalent_clock_bound_v1 (hoy/semana hasta la misma hora).
 */

import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import {
  calendarDateInTz,
  mondayOf,
  resolveOwnerPeriod,
  shiftCalendarDate,
  type OwnerPeriodPreset,
} from './resolveOwnerPeriod';
import { OWNER_METRICS_COMPARISON_POLICY } from './ownerMetrics.definitions';
import type {
  ComparisonRelationship,
  MetricsComparison,
  MetricsPeriod,
  PartialReason,
} from './ownerMetrics.types';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

export type OwnerMetricsWindows = {
  period: MetricsPeriod;
  comparison: MetricsComparison;
  comparisonPolicy: typeof OWNER_METRICS_COMPARISON_POLICY;
};

export type OwnerMetricsWindowsError = {
  error: 'period_required';
  missing: 'period';
};

const pad2 = (n: number) => String(n).padStart(2, '0');

const formatLocal = (instant: Date, tz: string): string => {
  const d = dayjs(instant).tz(tz);
  const offset = d.format('Z');
  return `${d.format('YYYY-MM-DDTHH:mm:ss')}${offset}`;
};

const localWallTime = (
  isoDate: string,
  hour: number,
  minute: number,
  second: number,
  tz: string
): Date =>
  dayjs.tz(
    `${isoDate} ${pad2(hour)}:${pad2(minute)}:${pad2(second)}`,
    'YYYY-MM-DD HH:mm:ss',
    tz
  ).toDate();

const startOfLocalDay = (isoDate: string, tz: string): Date =>
  localWallTime(isoDate, 0, 0, 0, tz);

/** Fin exclusivo del día calendario = 00:00 del día siguiente. */
const endOfLocalDayExclusive = (isoDate: string, tz: string): Date =>
  startOfLocalDay(shiftCalendarDate(isoDate, 1), tz);

const clockPartsInTz = (
  now: Date,
  tz: string
): { date: string; hour: number; minute: number; second: number } => {
  const d = dayjs(now).tz(tz);
  return {
    date: d.format('YYYY-MM-DD'),
    hour: d.hour(),
    minute: d.minute(),
    second: d.second(),
  };
};

const formatClockHm = (hour: number, minute: number): string =>
  `${pad2(hour)}:${pad2(minute)}`;

const buildWindow = (input: {
  timezone: string;
  startAt: Date;
  endAt: Date;
  isPartial: boolean;
  partialReason: PartialReason;
  labelForModel: string;
}): Omit<MetricsPeriod, 'preset'> => ({
  timezone: input.timezone,
  startAt: input.startAt.toISOString(),
  endAt: input.endAt.toISOString(),
  startLocal: formatLocal(input.startAt, input.timezone),
  endLocal: formatLocal(input.endAt, input.timezone),
  isPartial: input.isPartial,
  partialReason: input.partialReason,
  labelForModel: input.labelForModel,
});

export const resolveOwnerMetricsWindows = (input: {
  period: OwnerPeriodPreset;
  from?: string;
  to?: string;
  tz: string;
  now?: Date;
}): OwnerMetricsWindows | OwnerMetricsWindowsError => {
  const now = input.now ?? new Date();
  const resolved = resolveOwnerPeriod({
    period: input.period,
    from: input.from,
    to: input.to,
    tz: input.tz,
    now,
  });
  if ('error' in resolved) return resolved;

  const tz = input.tz;
  const clock = clockPartsInTz(now, tz);
  const today = calendarDateInTz(tz, now);

  if (resolved.preset === 'today') {
    const startAt = startOfLocalDay(today, tz);
    const endAt = now;
    const yesterday = shiftCalendarDate(today, -1);
    const cmpStart = startOfLocalDay(yesterday, tz);
    const cmpEnd = localWallTime(
      yesterday,
      clock.hour,
      clock.minute,
      clock.second,
      tz
    );
    const hm = formatClockHm(clock.hour, clock.minute);

    return {
      comparisonPolicy: OWNER_METRICS_COMPARISON_POLICY,
      period: {
        preset: 'today',
        ...buildWindow({
          timezone: tz,
          startAt,
          endAt,
          isPartial: true,
          partialReason: 'open_interval_until_now',
          labelForModel: `hoy hasta ahora (${hm} hora local)`,
        }),
      },
      comparison: {
        relationship: 'same_clock_previous_day',
        ...buildWindow({
          timezone: tz,
          startAt: cmpStart,
          endAt: cmpEnd,
          isPartial: true,
          partialReason: 'matched_to_current_clock',
          labelForModel: `ayer hasta la misma hora (${hm})`,
        }),
      },
    };
  }

  if (resolved.preset === 'yesterday') {
    const day = resolved.from;
    const prev = shiftCalendarDate(day, -1);
    return {
      comparisonPolicy: OWNER_METRICS_COMPARISON_POLICY,
      period: {
        preset: 'yesterday',
        ...buildWindow({
          timezone: tz,
          startAt: startOfLocalDay(day, tz),
          endAt: endOfLocalDayExclusive(day, tz),
          isPartial: false,
          partialReason: 'none',
          labelForModel: `ayer (${day}, día completo)`,
        }),
      },
      comparison: {
        relationship: 'previous_equivalent_full_day',
        ...buildWindow({
          timezone: tz,
          startAt: startOfLocalDay(prev, tz),
          endAt: endOfLocalDayExclusive(prev, tz),
          isPartial: false,
          partialReason: 'none',
          labelForModel: `anteayer (${prev}, día completo)`,
        }),
      },
    };
  }

  if (resolved.preset === 'this_week') {
    const weekStart = mondayOf(today);
    const startAt = startOfLocalDay(weekStart, tz);
    const endAt = now;
    const prevWeekStart = shiftCalendarDate(weekStart, -7);
    const prevSameWeekday = shiftCalendarDate(today, -7);
    const cmpStart = startOfLocalDay(prevWeekStart, tz);
    const cmpEnd = localWallTime(
      prevSameWeekday,
      clock.hour,
      clock.minute,
      clock.second,
      tz
    );
    const hm = formatClockHm(clock.hour, clock.minute);

    return {
      comparisonPolicy: OWNER_METRICS_COMPARISON_POLICY,
      period: {
        preset: 'this_week',
        ...buildWindow({
          timezone: tz,
          startAt,
          endAt,
          isPartial: true,
          partialReason: 'open_interval_until_now',
          labelForModel: `esta semana (lunes ${weekStart} → ahora ${hm})`,
        }),
      },
      comparison: {
        relationship: 'same_clock_previous_week' satisfies ComparisonRelationship,
        ...buildWindow({
          timezone: tz,
          startAt: cmpStart,
          endAt: cmpEnd,
          isPartial: true,
          partialReason: 'matched_to_current_clock',
          labelForModel: `semana anterior (lunes ${prevWeekStart} → ${prevSameWeekday} ${hm})`,
        }),
      },
    };
  }

  // custom: días calendario completos; comparación = bloque de igual duración antes
  const from = resolved.from;
  const to = resolved.to;
  const startAt = startOfLocalDay(from, tz);
  const endAt = endOfLocalDayExclusive(to, tz);
  const dayCount =
    Math.round(
      (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) /
        86_400_000
    ) + 1;
  const cmpTo = shiftCalendarDate(from, -1);
  const cmpFrom = shiftCalendarDate(cmpTo, -(dayCount - 1));

  return {
    comparisonPolicy: OWNER_METRICS_COMPARISON_POLICY,
    period: {
      preset: 'custom',
      ...buildWindow({
        timezone: tz,
        startAt,
        endAt,
        isPartial: false,
        partialReason: 'none',
        labelForModel: `rango ${from} → ${to} (días completos)`,
      }),
    },
    comparison: {
      relationship: 'previous_equal_duration',
      ...buildWindow({
        timezone: tz,
        startAt: startOfLocalDay(cmpFrom, tz),
        endAt: endOfLocalDayExclusive(cmpTo, tz),
        isPartial: false,
        partialReason: 'none',
        labelForModel: `período anterior equivalente (${cmpFrom} → ${cmpTo})`,
      }),
    },
  };
};
