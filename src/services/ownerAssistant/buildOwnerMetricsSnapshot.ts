import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import { prisma } from '../../lib/prisma';
import {
  DEFAULT_BUSINESS_TIMEZONE,
  DEFAULT_CURRENCY_CODE,
  EXCLUDED_ORDER_STATUSES,
  FRUSTRATED_SAMPLE_LIMIT,
  OWNER_METRICS_COMPARISON_POLICY,
  OWNER_METRICS_IN_FLIGHT_STATUSES,
  OWNER_METRICS_SCHEMA_VERSION,
  VALID_ORDER_STATUSES,
} from './ownerMetrics.definitions';
import {
  calcAverageTicket,
  calcCancellationRate,
  calcDeltaPct,
  roundMoney,
} from './ownerMetricsCalc';
import { resolveOwnerMetricsWindows } from './resolveOwnerComparisonPeriod';
import type { OwnerPeriodPreset } from './resolveOwnerPeriod';
import type { OwnerMetricsSnapshot } from './ownerMetrics.types';
import {
  queryCancelledCount,
  queryFrustratedCount,
  queryFrustratedSample,
  queryHumanHandledOpen,
  queryInFlightByStatus,
  querySalesAndOrders,
  queryTopProducts,
  queryUnpaidValidOrders,
} from './ownerMetricsQueries';

dayjs.extend(utc);
dayjs.extend(timezone);

export type BuildOwnerMetricsSnapshotInput = {
  businessId: string;
  period: OwnerPeriodPreset;
  from?: string;
  to?: string;
  topProductsLimit?: 1 | 3;
  excludeCustomerId?: string | null;
  now?: Date;
};

export type BuildOwnerMetricsSnapshotResult =
  | OwnerMetricsSnapshot
  | { error: 'period_required'; missing: 'period' };

const toWindow = (startAt: string, endAt: string) => ({
  startAt: new Date(startAt),
  endAt: new Date(endAt),
});

const CANCELLATION_TIME_NOTE =
  'No existe cancelled_at; se atribuye al momento de creación del pedido (orders.created_at).';

export async function buildOwnerMetricsSnapshot(
  input: BuildOwnerMetricsSnapshotInput
): Promise<BuildOwnerMetricsSnapshotResult> {
  const now = input.now ?? new Date();
  const topLimit = input.topProductsLimit === 3 ? 3 : 1;

  const business = await prisma.business.findUnique({
    where: { id: input.businessId },
    select: { timezone: true, currency_code: true },
  });
  const tz = business?.timezone ?? DEFAULT_BUSINESS_TIMEZONE;
  const currencyCode = business?.currency_code ?? DEFAULT_CURRENCY_CODE;

  const windows = resolveOwnerMetricsWindows({
    period: input.period,
    from: input.from,
    to: input.to,
    tz,
    now,
  });
  if ('error' in windows) return windows;

  const periodWin = toWindow(windows.period.startAt, windows.period.endAt);
  const cmpWin = toWindow(windows.comparison.startAt, windows.comparison.endAt);

  const [
    currentSalesOrders,
    previousSalesOrders,
    currentCancelled,
    previousCancelled,
    topRows,
    unpaidCount,
    frustratedCount,
    frustratedSample,
    inFlight,
    humanHandled,
  ] = await Promise.all([
    querySalesAndOrders(input.businessId, periodWin),
    querySalesAndOrders(input.businessId, cmpWin),
    queryCancelledCount(input.businessId, periodWin),
    queryCancelledCount(input.businessId, cmpWin),
    queryTopProducts(input.businessId, periodWin, topLimit),
    queryUnpaidValidOrders(input.businessId, periodWin),
    queryFrustratedCount(
      input.businessId,
      periodWin,
      input.excludeCustomerId
    ),
    queryFrustratedSample(
      input.businessId,
      periodWin,
      input.excludeCustomerId
    ),
    queryInFlightByStatus(input.businessId),
    queryHumanHandledOpen(input.businessId, input.excludeCustomerId),
  ]);

  const salesAmount = roundMoney(currentSalesOrders.sales);
  const prevSalesAmount = roundMoney(previousSalesOrders.sales);
  const ordersCount = currentSalesOrders.orders;
  const prevOrdersCount = previousSalesOrders.orders;

  const ticket = calcAverageTicket(salesAmount, ordersCount);
  const prevTicket = calcAverageTicket(prevSalesAmount, prevOrdersCount);

  const cancelRate = calcCancellationRate(currentCancelled, ordersCount);
  const prevCancelRate = calcCancellationRate(
    previousCancelled,
    prevOrdersCount
  );

  const unpaidSignal = {
    hasSignal: unpaidCount > 0,
    temporalNature: 'historical_period' as const,
    count: unpaidCount,
    accuracy: 'exact' as const,
    population: 'valid_orders_unpaid_in_period' as const,
    labelForModel: 'pedidos válidos del período aún sin cobrar',
  };
  const humanSignal = {
    hasSignal: humanHandled > 0,
    temporalNature: 'live_snapshot' as const,
    count: humanHandled,
    accuracy: 'exact' as const,
    labelForModel: 'chats abiertos en manejo humano ahora',
  };
  const frustratedSignal = {
    hasSignal: frustratedCount > 0,
    temporalNature: 'historical_period' as const,
    count: frustratedCount,
    accuracy: 'exact' as const,
    sample: frustratedSample,
    sampleLimit: FRUSTRATED_SAMPLE_LIMIT,
    sampleTruncated: frustratedCount > frustratedSample.length,
    labelForModel:
      'conversaciones con sentimiento FRUSTRATED o NEEDS_HUMAN en el período (count exacto; sample limitado)',
  };

  const snapshot: OwnerMetricsSnapshot = {
    schemaVersion: OWNER_METRICS_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    business: {
      businessId: input.businessId,
      timezone: tz,
      currencyCode,
    },
    definitions: {
      validOrderStatuses: [...VALID_ORDER_STATUSES],
      excludedOrderStatuses: [...EXCLUDED_ORDER_STATUSES],
      salesMeaning: 'sum_total_amount_of_valid_orders_not_collected_cash',
      cancellationTimeBasis: 'orders.created_at',
      comparisonPolicy: OWNER_METRICS_COMPARISON_POLICY,
      inFlightStatuses: [...OWNER_METRICS_IN_FLIGHT_STATUSES],
    },
    period: windows.period,
    comparison: windows.comparison,
    historical: {
      sales: {
        amount: salesAmount,
        currencyCode,
        comparison: {
          amount: prevSalesAmount,
          deltaAbsolute: roundMoney(salesAmount - prevSalesAmount),
          deltaPct: calcDeltaPct(salesAmount, prevSalesAmount),
        },
      },
      orders: {
        count: ordersCount,
        comparison: {
          count: prevOrdersCount,
          deltaAbsolute: ordersCount - prevOrdersCount,
          deltaPct: calcDeltaPct(ordersCount, prevOrdersCount),
        },
      },
      averageTicket: {
        amount: ticket,
        currencyCode,
        comparison: {
          amount: prevTicket,
          deltaAbsolute:
            ticket != null && prevTicket != null
              ? roundMoney(ticket - prevTicket)
              : null,
          deltaPct:
            ticket != null && prevTicket != null
              ? calcDeltaPct(ticket, prevTicket)
              : null,
        },
      },
      cancellations: {
        count: currentCancelled,
        rate: cancelRate?.rate ?? null,
        ratePct: cancelRate?.ratePct ?? null,
        denominator: cancelRate?.denominator ?? 0,
        denominatorMeaning: 'non_draft_orders_in_period',
        timeBasis: 'created_at',
        timeBasisNote: CANCELLATION_TIME_NOTE,
        comparison: {
          count: previousCancelled,
          rate: prevCancelRate?.rate ?? null,
          ratePct: prevCancelRate?.ratePct ?? null,
          denominator: prevCancelRate?.denominator ?? 0,
          deltaCountAbsolute: currentCancelled - previousCancelled,
          deltaCountPct: calcDeltaPct(currentCancelled, previousCancelled),
          deltaRatePctPoints:
            cancelRate != null && prevCancelRate != null
              ? cancelRate.ratePct - prevCancelRate.ratePct
              : null,
        },
      },
      topProducts: {
        rankingBy: 'units_sold',
        requestedLimit: topLimit,
        availableCount: topRows.length,
        items: topRows.map((row, index) => ({
          rank: index + 1,
          menuItemId: row.menuItemId,
          name: row.name,
          units: row.units,
          productSalesAmount: roundMoney(row.productSalesAmount),
          currencyCode,
        })),
      },
    },
    live: {
      asOf: now.toISOString(),
      asOfLocal: dayjs(now).tz(tz).format('YYYY-MM-DDTHH:mm:ssZ'),
      inFlightOrders: {
        total: inFlight.total,
        byStatus: inFlight.byStatus,
        detailAvailableVia: 'get_live_orders',
      },
      attention: {
        hasSignals:
          unpaidSignal.hasSignal ||
          humanSignal.hasSignal ||
          frustratedSignal.hasSignal,
        signals: {
          unpaidOrders: unpaidSignal,
          humanHandledConversations: humanSignal,
          frustratedConversations: frustratedSignal,
        },
      },
    },
  };

  return snapshot;
}
