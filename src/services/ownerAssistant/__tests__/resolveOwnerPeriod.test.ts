import { describe, expect, it } from 'vitest';
import { resolveOwnerPeriod } from '../resolveOwnerPeriod';

const NOW = new Date('2026-08-13T12:00:00.000Z');
const TZ = 'America/Argentina/Buenos_Aires';

describe('resolveOwnerPeriod', () => {
  it('today es el calendario en tz del negocio', () => {
    expect(resolveOwnerPeriod({ period: 'today', tz: TZ, now: NOW })).toEqual({
      from: '2026-08-13',
      to: '2026-08-13',
      preset: 'today',
    });
  });

  it('yesterday resta un día calendario', () => {
    expect(resolveOwnerPeriod({ period: 'yesterday', tz: TZ, now: NOW })).toEqual({
      from: '2026-08-12',
      to: '2026-08-12',
      preset: 'yesterday',
    });
  });

  it('this_week va del lunes a hoy', () => {
    expect(resolveOwnerPeriod({ period: 'this_week', tz: TZ, now: NOW })).toEqual({
      from: '2026-08-10',
      to: '2026-08-13',
      preset: 'this_week',
    });
  });

  it('custom inválido → period_required', () => {
    expect(resolveOwnerPeriod({ period: 'custom', tz: TZ, now: NOW })).toEqual({
      error: 'period_required',
      missing: 'period',
    });
    expect(
      resolveOwnerPeriod({
        period: 'custom',
        from: '2026-08-13',
        to: '2026-08-10',
        tz: TZ,
        now: NOW,
      })
    ).toEqual({ error: 'period_required', missing: 'period' });
  });

  it('custom válido', () => {
    expect(
      resolveOwnerPeriod({
        period: 'custom',
        from: '2026-08-01',
        to: '2026-08-13',
        tz: TZ,
        now: NOW,
      })
    ).toEqual({ from: '2026-08-01', to: '2026-08-13', preset: 'custom' });
  });
});
