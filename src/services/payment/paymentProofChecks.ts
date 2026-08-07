/**
 * Checks determinísticos sobre un comprobante de transferencia (Fase 7,
 * Tarea 7.2 de PLAN-ACCION-COMPROBANTES-CIERRE.md).
 *
 * Función pura, sin I/O: recibe lo ya extraído por visión, la orden, la
 * config bancaria del local y los resultados de las búsquedas de unicidad
 * (las hace el caller), y devuelve el objeto que va a `payment_proof.checks`.
 *
 * Cada check es 'pass' | 'fail' | 'unknown'. `unknown` cuando el dato no se
 * pudo extraer o no está configurado — nunca colapsa a `fail`, porque el
 * admin necesita distinguir "está mal" de "no sé" (D8: los checks nunca
 * deciden, solo informan; sigue siendo un humano el que aprueba, D3).
 */

import type { Prisma } from '@prisma/client';
import type { PaymentProofVisionResult } from '../ai/paymentProofVision.service';

export type CheckResult = 'pass' | 'fail' | 'unknown';

export type PaymentProofChecks = {
  amount_matches: CheckResult;
  destination_matches: CheckResult;
  date_within_window: CheckResult;
  operation_number_unique: CheckResult;
  image_not_reused: CheckResult;
  image_reused_in_order_id?: string;
};

/** Margen antes de `order.created_at` para tolerar pequeños desfasajes de reloj/red. */
const DATE_WINDOW_MARGIN_BEFORE_MS = 15 * 60 * 1000;

function normalizeAlias(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed.toLowerCase();
}

function normalizeCbu(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\s-]/g, '');
  return cleaned.length === 0 ? null : cleaned;
}

function checkAmountMatches(
  extractedAmount: number | null,
  orderTotal: Prisma.Decimal | number | null
): CheckResult {
  if (extractedAmount === null || orderTotal === null) return 'unknown';
  const orderAmount = typeof orderTotal === 'number' ? orderTotal : orderTotal.toNumber();
  return extractedAmount.toFixed(2) === orderAmount.toFixed(2) ? 'pass' : 'fail';
}

function checkDestinationMatches(
  extracted: Pick<PaymentProofVisionResult, 'destination_alias' | 'destination_cbu'> | null,
  bankConfig: { bank_alias: string | null; bank_cbu: string | null } | null
): CheckResult {
  const configuredAlias = normalizeAlias(bankConfig?.bank_alias);
  const configuredCbu = normalizeCbu(bankConfig?.bank_cbu);
  if (!configuredAlias && !configuredCbu) return 'unknown';

  const extractedAlias = normalizeAlias(extracted?.destination_alias);
  const extractedCbu = normalizeCbu(extracted?.destination_cbu);
  if (!extractedAlias && !extractedCbu) return 'unknown';

  const aliasMatches = configuredAlias !== null && extractedAlias !== null && configuredAlias === extractedAlias;
  const cbuMatches = configuredCbu !== null && extractedCbu !== null && configuredCbu === extractedCbu;

  return aliasMatches || cbuMatches ? 'pass' : 'fail';
}

function checkDateWithinWindow(
  transferredAt: string | null,
  orderCreatedAt: Date,
  now: Date
): CheckResult {
  if (!transferredAt) return 'unknown';
  const parsed = new Date(transferredAt);
  if (Number.isNaN(parsed.getTime())) return 'unknown';

  const windowStart = orderCreatedAt.getTime() - DATE_WINDOW_MARGIN_BEFORE_MS;
  const windowEnd = now.getTime();
  return parsed.getTime() >= windowStart && parsed.getTime() <= windowEnd ? 'pass' : 'fail';
}

function checkOperationNumberUnique(
  operationNumber: string | null,
  operationNumberAlreadyUsed: boolean
): CheckResult {
  if (!operationNumber) return 'unknown';
  return operationNumberAlreadyUsed ? 'fail' : 'pass';
}

/**
 * ¿Este `checks` (tal como quedó persistido en `payment_proof.checks`) tiene
 * al menos un check en `fail`?
 *
 * Se lee desde JSONB, así que la entrada es `unknown` a propósito: hay filas
 * viejas con la forma reducida de la Fase 4 (`{ image_not_reused }`) y filas
 * sin checks. Un `unknown` nunca cuenta como fallo — esa distinción es la que
 * evita que un comprobante ilegible acerque a nadie al escalamiento (Fase 8).
 */
export function hasFailedCheck(checks: unknown): boolean {
  if (typeof checks !== 'object' || checks === null) return false;
  return Object.values(checks as Record<string, unknown>).some((value) => value === 'fail');
}

export function computePaymentProofChecks(params: {
  extracted: PaymentProofVisionResult | null;
  order: { total_amount: Prisma.Decimal | number | null; created_at: Date };
  bankConfig: { bank_alias: string | null; bank_cbu: string | null } | null;
  operationNumberAlreadyUsed: boolean;
  imageReusedInOrderId: string | null;
  now?: Date;
}): PaymentProofChecks {
  const { extracted, order, bankConfig, operationNumberAlreadyUsed, imageReusedInOrderId } = params;
  const now = params.now ?? new Date();

  return {
    amount_matches: checkAmountMatches(extracted?.amount ?? null, order.total_amount),
    destination_matches: checkDestinationMatches(extracted, bankConfig),
    date_within_window: checkDateWithinWindow(extracted?.transferred_at ?? null, order.created_at, now),
    operation_number_unique: checkOperationNumberUnique(
      extracted?.operation_number ?? null,
      operationNumberAlreadyUsed
    ),
    image_not_reused: imageReusedInOrderId === null ? 'pass' : 'fail',
    ...(imageReusedInOrderId ? { image_reused_in_order_id: imageReusedInOrderId } : {}),
  };
}
