/**
 * Catálogo de plataforma de métodos de pago.
 * Define qué IDs existen y cómo se comportan en runtime.
 * La aceptación por local vive en `payment_method_config` (Postgres).
 */

export const PAYMENT_METHOD_IDS = ['cash', 'online', 'transfer'] as const;

export type PaymentMethodId = (typeof PAYMENT_METHOD_IDS)[number];

export type PaymentCollectionKind =
  | 'at_delivery'
  | 'online_provider'
  | 'bank_transfer';

export type PaymentMethodDefinition = {
  id: PaymentMethodId;
  defaultLabel: string;
  /** Prefijo corto para botón WhatsApp (máx ~20 chars con monto). */
  buttonTitle: string;
  emoji: string;
  buttonId: string;
  collectionKind: PaymentCollectionKind;
  allowedWithExternalDelivery: boolean;
  /** Frases exactas (normalizadas) que mapean a este método. */
  aliases: readonly string[];
  sortOrder: number;
};

export const PAYMENT_METHOD_CATALOG: Record<PaymentMethodId, PaymentMethodDefinition> = {
  cash: {
    id: 'cash',
    defaultLabel: 'Efectivo',
    buttonTitle: 'Efectivo',
    emoji: '💵',
    buttonId: 'PAY_CASH',
    collectionKind: 'at_delivery',
    allowedWithExternalDelivery: false,
    aliases: [
      'efectivo',
      'cash',
      'en efectivo',
      'en mano',
      'pago en efectivo',
      'con efectivo',
      'pago al recibir',
    ],
    sortOrder: 0,
  },
  online: {
    id: 'online',
    defaultLabel: 'Pago online',
    buttonTitle: 'Pago online',
    emoji: '💳',
    buttonId: 'PAY_ONLINE',
    collectionKind: 'online_provider',
    allowedWithExternalDelivery: true,
    aliases: [
      'online',
      'tarjeta',
      'mercado pago',
      'mercadopago',
      'pago online',
      'con tarjeta',
      'digital',
    ],
    sortOrder: 1,
  },
  transfer: {
    id: 'transfer',
    defaultLabel: 'Transferencia',
    buttonTitle: 'Transferencia',
    emoji: '🏦',
    buttonId: 'PAY_TRANSFER',
    collectionKind: 'bank_transfer',
    allowedWithExternalDelivery: true,
    aliases: [
      'transferencia',
      'transfer',
      'transferir',
      'por transferencia',
      'cbu',
      'alias',
      'banco',
    ],
    sortOrder: 2,
  },
};

export const PAYMENT_METHOD_LIST: PaymentMethodDefinition[] = PAYMENT_METHOD_IDS.map(
  (id) => PAYMENT_METHOD_CATALOG[id]
).sort((a, b) => a.sortOrder - b.sortOrder);

export function isPaymentMethodId(value: string): value is PaymentMethodId {
  return (PAYMENT_METHOD_IDS as readonly string[]).includes(value);
}

export function getPaymentMethod(id: PaymentMethodId): PaymentMethodDefinition {
  return PAYMENT_METHOD_CATALOG[id];
}

/** Parsea `PAY_CASH` / `PAY_ONLINE` / `PAY_TRANSFER` → id de catálogo. */
export function parsePayButtonId(payloadId: string): PaymentMethodId | null {
  if (!payloadId.startsWith('PAY_')) return null;
  const suffix = payloadId.slice('PAY_'.length).toLowerCase();
  return isPaymentMethodId(suffix) ? suffix : null;
}

export function paymentMethodLabel(id: PaymentMethodId): string {
  return PAYMENT_METHOD_CATALOG[id].defaultLabel;
}

export function isUnpaidCollectionKind(kind: PaymentCollectionKind): boolean {
  return kind === 'at_delivery' || kind === 'bank_transfer';
}
