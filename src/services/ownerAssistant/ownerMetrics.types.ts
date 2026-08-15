import type { OrderStatus } from '@prisma/client';
import type { OwnerPeriodPreset } from './resolveOwnerPeriod';

export type MetricsAccuracy = 'exact' | 'approximate_capped';

export type MetricsTemporalNature = 'historical_period' | 'live_snapshot';

export type ComparisonRelationship =
  | 'same_clock_previous_day'
  | 'previous_equivalent_full_day'
  | 'same_clock_previous_week'
  | 'previous_equal_duration';

export type PartialReason =
  | 'open_interval_until_now'
  | 'matched_to_current_clock'
  | 'none';

export type MetricsTimeWindow = {
  timezone: string;
  /** Inclusive start (UTC ISO). */
  startAt: string;
  /** Exclusive end (UTC ISO). Interval = [startAt, endAt). */
  endAt: string;
  startLocal: string;
  endLocal: string;
  isPartial: boolean;
  partialReason: PartialReason;
  labelForModel: string;
};

export type MetricsPeriod = MetricsTimeWindow & {
  preset: OwnerPeriodPreset;
};

export type MetricsComparison = MetricsTimeWindow & {
  relationship: ComparisonRelationship;
};

export type ComparedAmount = {
  amount: number;
  deltaAbsolute: number;
  deltaPct: number;
};

export type ComparedCount = {
  count: number;
  deltaAbsolute: number;
  deltaPct: number;
};

export type SalesMetric = {
  amount: number;
  currencyCode: string;
  comparison: ComparedAmount;
};

export type OrdersMetric = {
  count: number;
  comparison: ComparedCount;
};

export type AverageTicketMetric = {
  amount: number | null;
  currencyCode: string;
  comparison: {
    amount: number | null;
    deltaAbsolute: number | null;
    deltaPct: number | null;
  };
};

export type CancellationsMetric = {
  count: number;
  rate: number | null;
  ratePct: number | null;
  denominator: number;
  denominatorMeaning: 'non_draft_orders_in_period';
  timeBasis: 'created_at';
  timeBasisNote: string;
  comparison: {
    count: number;
    rate: number | null;
    ratePct: number | null;
    denominator: number;
    deltaCountAbsolute: number;
    deltaCountPct: number;
    deltaRatePctPoints: number | null;
  };
};

export type TopProductItem = {
  rank: number;
  menuItemId: string;
  name: string;
  units: number;
  productSalesAmount: number;
  currencyCode: string;
};

export type TopProductsMetric = {
  rankingBy: 'units_sold';
  items: TopProductItem[];
  requestedLimit: number;
  availableCount: number;
};

export type AttentionSignalBase = {
  hasSignal: boolean;
  temporalNature: MetricsTemporalNature;
  count: number;
  accuracy: MetricsAccuracy;
  labelForModel: string;
};

export type UnpaidOrdersSignal = AttentionSignalBase & {
  population: 'valid_orders_unpaid_in_period';
};

export type HumanHandledSignal = AttentionSignalBase;

export type FrustratedSampleItem = {
  customerName: string | null;
  sentiment: string;
};

export type FrustratedConversationsSignal = AttentionSignalBase & {
  sample: FrustratedSampleItem[];
  sampleLimit: number;
  sampleTruncated: boolean;
};

export type AttentionBlock = {
  hasSignals: boolean;
  signals: {
    unpaidOrders: UnpaidOrdersSignal;
    humanHandledConversations: HumanHandledSignal;
    frustratedConversations: FrustratedConversationsSignal;
  };
};

export type InFlightStatusBucket = {
  count: number;
  label: string;
};

export type InFlightOrdersLive = {
  total: number;
  byStatus: Record<string, InFlightStatusBucket>;
  detailAvailableVia: 'get_live_orders';
};

export type OwnerMetricsDefinitions = {
  validOrderStatuses: OrderStatus[];
  excludedOrderStatuses: OrderStatus[];
  salesMeaning: 'sum_total_amount_of_valid_orders_not_collected_cash';
  cancellationTimeBasis: 'orders.created_at';
  comparisonPolicy: string;
  inFlightStatuses: OrderStatus[];
};

export type OwnerMetricsSnapshot = {
  schemaVersion: string;
  generatedAt: string;
  business: {
    businessId: string;
    timezone: string;
    currencyCode: string;
  };
  definitions: OwnerMetricsDefinitions;
  period: MetricsPeriod;
  comparison: MetricsComparison;
  historical: {
    sales: SalesMetric;
    orders: OrdersMetric;
    averageTicket: AverageTicketMetric;
    cancellations: CancellationsMetric;
    topProducts: TopProductsMetric;
  };
  live: {
    asOf: string;
    asOfLocal: string;
    inFlightOrders: InFlightOrdersLive;
    attention: AttentionBlock;
  };
};
