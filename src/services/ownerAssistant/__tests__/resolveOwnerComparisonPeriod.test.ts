import { describe, expect, it } from 'vitest';
import { resolveOwnerMetricsWindows } from '../resolveOwnerComparisonPeriod';

const TZ = 'America/Argentina/Buenos_Aires';
/** Sábado 15 ago 2026 15:00 ART = 18:00 UTC */
const SAT_15H = new Date('2026-08-15T18:00:00.000Z');

describe('resolveOwnerMetricsWindows', () => {
  it('today: hasta ahora vs ayer misma hora', () => {
    const result = resolveOwnerMetricsWindows({
      period: 'today',
      tz: TZ,
      now: SAT_15H,
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.period.preset).toBe('today');
    expect(result.period.isPartial).toBe(true);
    expect(result.period.startAt).toBe('2026-08-15T03:00:00.000Z');
    expect(result.period.endAt).toBe(SAT_15H.toISOString());
    expect(result.period.labelForModel).toContain('hoy hasta ahora');
    expect(result.period.labelForModel).toContain('15:00');

    expect(result.comparison.relationship).toBe('same_clock_previous_day');
    expect(result.comparison.startAt).toBe('2026-08-14T03:00:00.000Z');
    expect(result.comparison.endAt).toBe('2026-08-14T18:00:00.000Z');
    expect(result.comparison.labelForModel).toContain('ayer hasta la misma hora');
  });

  it('yesterday: día completo vs anteayer completo', () => {
    const result = resolveOwnerMetricsWindows({
      period: 'yesterday',
      tz: TZ,
      now: SAT_15H,
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.period.preset).toBe('yesterday');
    expect(result.period.isPartial).toBe(false);
    expect(result.period.startAt).toBe('2026-08-14T03:00:00.000Z');
    expect(result.period.endAt).toBe('2026-08-15T03:00:00.000Z');
    expect(result.comparison.relationship).toBe('previous_equivalent_full_day');
    expect(result.comparison.startAt).toBe('2026-08-13T03:00:00.000Z');
    expect(result.comparison.endAt).toBe('2026-08-14T03:00:00.000Z');
  });

  it('this_week: lun→ahora vs lun sem ant→mismo weekday+hora', () => {
    const result = resolveOwnerMetricsWindows({
      period: 'this_week',
      tz: TZ,
      now: SAT_15H,
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    // 15 ago 2026 es sábado; lunes = 10 ago
    expect(result.period.startAt).toBe('2026-08-10T03:00:00.000Z');
    expect(result.period.endAt).toBe(SAT_15H.toISOString());
    expect(result.comparison.relationship).toBe('same_clock_previous_week');
    expect(result.comparison.startAt).toBe('2026-08-03T03:00:00.000Z');
    expect(result.comparison.endAt).toBe('2026-08-08T18:00:00.000Z');
  });

  it('custom: días completos vs bloque igual duración previo', () => {
    const result = resolveOwnerMetricsWindows({
      period: 'custom',
      from: '2026-08-01',
      to: '2026-08-03',
      tz: TZ,
      now: SAT_15H,
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.period.preset).toBe('custom');
    expect(result.period.startAt).toBe('2026-08-01T03:00:00.000Z');
    expect(result.period.endAt).toBe('2026-08-04T03:00:00.000Z');
    expect(result.comparison.relationship).toBe('previous_equal_duration');
    expect(result.comparison.startAt).toBe('2026-07-29T03:00:00.000Z');
    expect(result.comparison.endAt).toBe('2026-08-01T03:00:00.000Z');
  });

  it('custom inválido → period_required', () => {
    expect(
      resolveOwnerMetricsWindows({
        period: 'custom',
        tz: TZ,
        now: SAT_15H,
      })
    ).toEqual({ error: 'period_required', missing: 'period' });
  });
});
