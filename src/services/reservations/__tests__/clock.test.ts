/**
 * El reloj único del flujo de reservas: si el ledger y el gate no comparten
 * origen, el modelo lee un "hoy" y el borde valida contra otro.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  coerceIanaTimezone,
  currentDateLabel,
  formatDMY,
  formatDraftDateWithWeekday,
  nextDateForWeekday,
  RESERVATION_TIMEZONE_FALLBACK,
  reservationToday,
  weekdayNameEs,
} from '../clock';

const ART = 'America/Argentina/Buenos_Aires';
const MADRID = 'Europe/Madrid';

describe('clock de reservas', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // domingo 30/08/2026, 23:40 — hora tardía a propósito: el label y el
    // límite de "pasado" tienen que seguir hablando del mismo día.
    vi.setSystemTime(new Date(2026, 7, 30, 23, 40, 0));
  });

  afterEach(() => vi.useRealTimers());

  it('el label del ledger trae fecha y día en el formato que valida el gate', () => {
    expect(currentDateLabel(ART)).toBe('30/08/2026 (domingo)');
  });

  it('reservationToday es medianoche del mismo día que muestra el ledger', () => {
    const today = reservationToday(ART);
    expect(formatDMY(today)).toBe('30/08/2026');
    expect(today.getHours()).toBe(0);
  });

  it('nextDateForWeekday nunca devuelve hoy, aunque hoy sea ese día', () => {
    expect(weekdayNameEs(reservationToday(ART))).toBe('domingo');
    expect(formatDMY(nextDateForWeekday('domingo', ART))).toBe('06/09/2026');
    expect(formatDMY(nextDateForWeekday('viernes', ART))).toBe('04/09/2026');
  });

  it('el mismo instante UTC es otro día civil según la zona del local', () => {
    // 24/09/2026 01:09 UTC = miércoles 23/09 22:09 en Buenos Aires
    // y jueves 24/09 03:09 en Madrid (CEST).
    vi.setSystemTime(new Date('2026-09-24T01:09:00.000Z'));
    expect(currentDateLabel(ART)).toBe('23/09/2026 (miércoles)');
    expect(currentDateLabel(MADRID)).toBe('24/09/2026 (jueves)');
    expect(currentDateLabel('America/Mexico_City')).toBe('23/09/2026 (miércoles)');
    const saturdayArt = nextDateForWeekday('sábado', ART);
    expect(formatDMY(saturdayArt)).toBe('26/09/2026');
    expect(weekdayNameEs(saturdayArt)).toBe('sábado');
    expect(formatDMY(nextDateForWeekday('sábado', MADRID))).toBe('26/09/2026');
  });

  it('una zona vacía o inválida cae al default de la columna', () => {
    expect(coerceIanaTimezone(null)).toBe(RESERVATION_TIMEZONE_FALLBACK);
    expect(coerceIanaTimezone('   ')).toBe(RESERVATION_TIMEZONE_FALLBACK);
    expect(coerceIanaTimezone('Not/AZone')).toBe(RESERVATION_TIMEZONE_FALLBACK);
    expect(coerceIanaTimezone('  Europe/Madrid  ')).toBe('Europe/Madrid');
  });

  it('formatDraftDateWithWeekday usa el calendario (19/09/2026 = sábado, no miércoles)', () => {
    expect(formatDraftDateWithWeekday('19/09/2026')).toBe('19/09/2026 (sábado)');
    expect(formatDraftDateWithWeekday('16/09/2026')).toBe('16/09/2026 (miércoles)');
  });
});
