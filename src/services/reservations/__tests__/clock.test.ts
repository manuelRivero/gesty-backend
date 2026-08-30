/**
 * El reloj único del flujo de reservas: si el ledger y el gate no comparten
 * origen, el modelo lee un "hoy" y el borde valida contra otro.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  currentDateLabel,
  formatDMY,
  nextDateForWeekday,
  reservationToday,
  weekdayNameEs,
} from '../clock';

describe('clock de reservas', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // domingo 30/08/2026, 23:40 — hora tardía a propósito: el label y el
    // límite de "pasado" tienen que seguir hablando del mismo día.
    vi.setSystemTime(new Date(2026, 7, 30, 23, 40, 0));
  });

  afterEach(() => vi.useRealTimers());

  it('el label del ledger trae fecha y día en el formato que valida el gate', () => {
    expect(currentDateLabel()).toBe('30/08/2026 (domingo)');
  });

  it('reservationToday es medianoche del mismo día que muestra el ledger', () => {
    const today = reservationToday();
    expect(formatDMY(today)).toBe('30/08/2026');
    expect(today.getHours()).toBe(0);
  });

  it('nextDateForWeekday nunca devuelve hoy, aunque hoy sea ese día', () => {
    expect(weekdayNameEs(reservationToday())).toBe('domingo');
    expect(formatDMY(nextDateForWeekday('domingo'))).toBe('06/09/2026');
    expect(formatDMY(nextDateForWeekday('viernes'))).toBe('04/09/2026');
  });
});
