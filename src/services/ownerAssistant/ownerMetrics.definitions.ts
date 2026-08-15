import { OrderStatus } from '@prisma/client';
import { IN_FLIGHT_ORDER_STATUSES } from './labels';

/** Pedidos V1: ventas, conteo y ticket. */
export const VALID_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.placed,
  OrderStatus.preparing,
  OrderStatus.ready_for_pickup,
  OrderStatus.shipped,
  OrderStatus.delivered,
];

export const EXCLUDED_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.draft,
  OrderStatus.cancelled,
];

export const OWNER_METRICS_SCHEMA_VERSION = 'owner-metrics-v1';

export const OWNER_METRICS_COMPARISON_POLICY = 'equivalent_clock_bound_v1';

export const OWNER_METRICS_IN_FLIGHT_STATUSES = IN_FLIGHT_ORDER_STATUSES;

export const FRUSTRATED_SAMPLE_LIMIT = 8;

export const DEFAULT_CURRENCY_CODE = 'ARS';

export const DEFAULT_BUSINESS_TIMEZONE = 'America/Argentina/Buenos_Aires';
