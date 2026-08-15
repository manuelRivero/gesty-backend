/**
 * Cálculos puros del snapshot de métricas del dueño.
 * El LLM no debe recalcular estos valores.
 */

export function calcDeltaPct(current: number, previous: number): number {
  if (previous === 0) {
    return current === 0 ? 0 : 100;
  }
  return Math.round(((current - previous) / previous) * 100);
}

export function calcAverageTicket(sales: number, orders: number): number | null {
  if (orders <= 0) return null;
  return Math.round((sales / orders) * 100) / 100;
}

export function calcCancellationRate(
  cancelled: number,
  validOrders: number
): { rate: number; ratePct: number; denominator: number } | null {
  const denominator = validOrders + cancelled;
  if (denominator <= 0) return null;
  const rate = cancelled / denominator;
  return {
    rate,
    ratePct: Math.round(rate * 100),
    denominator,
  };
}

export function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}
