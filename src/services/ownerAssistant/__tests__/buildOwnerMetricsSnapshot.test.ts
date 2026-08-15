import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../lib/prisma', () => ({
  prisma: {
    business: { findUnique: vi.fn() },
  },
}));

vi.mock('../ownerMetricsQueries', () => ({
  querySalesAndOrders: vi.fn(),
  queryCancelledCount: vi.fn(),
  queryTopProducts: vi.fn(),
  queryUnpaidValidOrders: vi.fn(),
  queryFrustratedCount: vi.fn(),
  queryFrustratedSample: vi.fn(),
  queryInFlightByStatus: vi.fn(),
  queryHumanHandledOpen: vi.fn(),
}));

import { prisma } from '../../../lib/prisma';
import { buildOwnerMetricsSnapshot } from '../buildOwnerMetricsSnapshot';
import * as queries from '../ownerMetricsQueries';

const NOW = new Date('2026-08-15T18:00:00.000Z');
const TZ = 'America/Argentina/Buenos_Aires';

describe('buildOwnerMetricsSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.business.findUnique).mockResolvedValue({
      timezone: TZ,
      currency_code: 'ARS',
    } as never);

    vi.mocked(queries.querySalesAndOrders)
      .mockResolvedValueOnce({ sales: 185000, orders: 42 })
      .mockResolvedValueOnce({ sales: 150000, orders: 35 });
    vi.mocked(queries.queryCancelledCount)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1);
    vi.mocked(queries.queryTopProducts).mockResolvedValue([
      {
        menuItemId: 'item-1',
        name: 'Milanesa',
        units: 28,
        productSalesAmount: 84000,
      },
    ]);
    vi.mocked(queries.queryUnpaidValidOrders).mockResolvedValue(4);
    vi.mocked(queries.queryFrustratedCount).mockResolvedValue(2);
    vi.mocked(queries.queryFrustratedSample).mockResolvedValue([
      { customerName: 'María', sentiment: 'FRUSTRATED' },
      { customerName: 'Luis', sentiment: 'NEEDS_HUMAN' },
    ]);
    vi.mocked(queries.queryInFlightByStatus).mockResolvedValue({
      total: 5,
      byStatus: {
        placed: { count: 2, label: 'en cola' },
        preparing: { count: 2, label: 'en cocina' },
        ready_for_pickup: { count: 0, label: 'listo para retirar' },
        shipped: { count: 1, label: 'en camino' },
      },
    });
    vi.mocked(queries.queryHumanHandledOpen).mockResolvedValue(1);
  });

  it('arma snapshot con deltas, ticket e invariantes', async () => {
    const result = await buildOwnerMetricsSnapshot({
      businessId: 'biz-1',
      period: 'today',
      now: NOW,
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.schemaVersion).toBe('owner-metrics-v1');
    expect(result.historical.sales.amount).toBe(185000);
    expect(result.historical.sales.comparison.deltaPct).toBe(23);
    expect(result.historical.orders.count).toBe(42);
    expect(result.historical.averageTicket.amount).toBe(4404.76);
    expect(result.historical.cancellations.denominator).toBe(45);
    expect(result.historical.cancellations.ratePct).toBe(7);
    expect(result.historical.topProducts.items[0]?.name).toBe('Milanesa');
    expect(result.live.inFlightOrders.total).toBe(5);
    expect(result.live.attention.hasSignals).toBe(true);
    expect(result.live.attention.signals.frustratedConversations.count).toBe(2);
    expect(result.live.attention.signals.frustratedConversations.accuracy).toBe(
      'exact'
    );

    // Invariante: denominator = valid + cancelled
    expect(result.historical.cancellations.denominator).toBe(
      result.historical.orders.count + result.historical.cancellations.count
    );
  });

  it('ticket null cuando no hay pedidos', async () => {
    vi.mocked(queries.querySalesAndOrders)
      .mockReset()
      .mockResolvedValueOnce({ sales: 0, orders: 0 })
      .mockResolvedValueOnce({ sales: 0, orders: 0 });
    vi.mocked(queries.queryCancelledCount)
      .mockReset()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0);
    vi.mocked(queries.queryTopProducts).mockResolvedValue([]);
    vi.mocked(queries.queryUnpaidValidOrders).mockResolvedValue(0);
    vi.mocked(queries.queryFrustratedCount).mockResolvedValue(0);
    vi.mocked(queries.queryFrustratedSample).mockResolvedValue([]);
    vi.mocked(queries.queryHumanHandledOpen).mockResolvedValue(0);
    vi.mocked(queries.queryInFlightByStatus).mockResolvedValue({
      total: 0,
      byStatus: {},
    });

    const result = await buildOwnerMetricsSnapshot({
      businessId: 'biz-1',
      period: 'today',
      now: NOW,
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.historical.averageTicket.amount).toBeNull();
    expect(result.live.attention.hasSignals).toBe(false);
  });
});
