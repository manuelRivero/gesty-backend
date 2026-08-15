import { describe, expect, it } from 'vitest';
import {
  calcAverageTicket,
  calcCancellationRate,
  calcDeltaPct,
} from '../ownerMetricsCalc';

describe('ownerMetricsCalc', () => {
  describe('calcDeltaPct', () => {
    it('prev 0 y actual 0 → 0', () => {
      expect(calcDeltaPct(0, 0)).toBe(0);
    });
    it('prev 0 y actual > 0 → 100', () => {
      expect(calcDeltaPct(10, 0)).toBe(100);
    });
    it('redondea al entero más cercano', () => {
      expect(calcDeltaPct(185000, 150000)).toBe(23);
    });
  });

  describe('calcAverageTicket', () => {
    it('null si no hay pedidos', () => {
      expect(calcAverageTicket(100, 0)).toBeNull();
    });
    it('nunca devuelve 0 por ausencia de pedidos', () => {
      expect(calcAverageTicket(0, 0)).toBeNull();
    });
    it('redondea a 2 decimales', () => {
      expect(calcAverageTicket(185000, 42)).toBe(4404.76);
    });
  });

  describe('calcCancellationRate', () => {
    it('null si no hay no-draft', () => {
      expect(calcCancellationRate(0, 0)).toBeNull();
    });
    it('cancelled / (valid + cancelled)', () => {
      expect(calcCancellationRate(3, 42)).toEqual({
        rate: 3 / 45,
        ratePct: 7,
        denominator: 45,
      });
    });
  });
});
