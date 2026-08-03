import { prisma } from '../lib/prisma';
import {
  PAYMENT_METHOD_CATALOG,
  PAYMENT_METHOD_LIST,
  getPaymentMethod,
  isPaymentMethodId,
  type PaymentMethodId,
  type PaymentMethodDefinition,
} from '../domain/payment/paymentMethods';
import { filterMethodsForFulfillmentContext } from '../domain/payment/paymentMethodRules';
import { getActiveProvider } from './payment/paymentProvider.repository';

export type OfferedPaymentMethod = {
  id: PaymentMethodId;
  label: string;
  buttonId: string;
  buttonTitle: string;
  emoji: string;
  collectionKind: PaymentMethodDefinition['collectionKind'];
  instructions: string | null;
  sortOrder: number;
};

const DEFAULT_SEED: Array<{
  id: PaymentMethodId;
  isActive: boolean;
  adjustmentType: 'FIXED';
  adjustmentValue: number;
  isSurcharge: boolean;
}> = [
  { id: 'cash', isActive: true, adjustmentType: 'FIXED', adjustmentValue: 0, isSurcharge: false },
  { id: 'online', isActive: true, adjustmentType: 'FIXED', adjustmentValue: 0, isSurcharge: false },
  { id: 'transfer', isActive: false, adjustmentType: 'FIXED', adjustmentValue: 0, isSurcharge: false },
];

/**
 * Garantiza filas default en payment_method_config para un negocio.
 * cash+online activos, transfer inactivo (compatibilidad con el checkout previo).
 */
export async function ensureDefaultPaymentMethodConfigs(
  businessId: string
): Promise<void> {
  const existing = await prisma.payment_method_config.findMany({
    where: { business_id: businessId },
    select: { payment_method: true },
  });
  const existingSet = new Set(existing.map((r) => r.payment_method));

  const missing = DEFAULT_SEED.filter((d) => !existingSet.has(d.id));
  if (missing.length === 0) return;

  await prisma.payment_method_config.createMany({
    data: missing.map((d) => ({
      business_id: businessId,
      payment_method: d.id,
      label: PAYMENT_METHOD_CATALOG[d.id].defaultLabel,
      adjustment_type: d.adjustmentType,
      adjustment_value: d.adjustmentValue,
      is_surcharge: d.isSurcharge,
      is_active: d.isActive,
      sort_order: PAYMENT_METHOD_CATALOG[d.id].sortOrder,
      instructions: null,
    })),
    skipDuplicates: true,
  });
}

export async function listActivePaymentMethodSnapshots(
  businessId: string
): Promise<Array<{ paymentMethod: string; isActive: boolean }>> {
  await ensureDefaultPaymentMethodConfigs(businessId);
  const rows = await prisma.payment_method_config.findMany({
    where: { business_id: businessId },
    select: { payment_method: true, is_active: true },
  });
  return rows.map((r) => ({
    paymentMethod: r.payment_method,
    isActive: r.is_active,
  }));
}

/**
 * Métodos que el checkout debe ofrecer al cliente ahora:
 * activos en config ∩ compatibles con delivery externo ∩ online con provider MP.
 */
export async function listOfferedPaymentMethods(
  businessId: string,
  options: { externalDeliveryEnabled: boolean }
): Promise<OfferedPaymentMethod[]> {
  await ensureDefaultPaymentMethodConfigs(businessId);

  const { externalDeliveryEnabled } = options;

  const rows = await prisma.payment_method_config.findMany({
    where: { business_id: businessId, is_active: true },
    orderBy: [{ sort_order: 'asc' }, { payment_method: 'asc' }],
  });

  let ids = rows
    .map((r) => r.payment_method)
    .filter(isPaymentMethodId);

  ids = filterMethodsForFulfillmentContext(ids, { externalDeliveryEnabled });

  const hasOnlineProvider = ids.includes('online')
    ? Boolean(await getActiveProvider(businessId, 'mercado_pago'))
    : false;

  if (ids.includes('online') && !hasOnlineProvider) {
    ids = ids.filter((id) => id !== 'online');
  }

  const rowByMethod = new Map(rows.map((r) => [r.payment_method, r]));

  return ids
    .map((id) => {
      const def = getPaymentMethod(id);
      const row = rowByMethod.get(id);
      return {
        id,
        label: row?.label ?? def.defaultLabel,
        buttonId: def.buttonId,
        buttonTitle: def.buttonTitle,
        emoji: def.emoji,
        collectionKind: def.collectionKind,
        instructions: row?.instructions ?? null,
        sortOrder: row?.sort_order ?? def.sortOrder,
      };
    })
    .sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export async function isPaymentMethodOffered(
  businessId: string,
  method: string,
  options: { externalDeliveryEnabled: boolean }
): Promise<boolean> {
  if (!isPaymentMethodId(method)) return false;
  const offered = await listOfferedPaymentMethods(businessId, options);
  return offered.some((m) => m.id === method);
}

export function getPaymentMethodCatalogForAdmin(): Array<{
  id: PaymentMethodId;
  defaultLabel: string;
  allowedWithExternalDelivery: boolean;
  collectionKind: string;
}> {
  return PAYMENT_METHOD_LIST.map((m) => ({
    id: m.id,
    defaultLabel: m.defaultLabel,
    allowedWithExternalDelivery: m.allowedWithExternalDelivery,
    collectionKind: m.collectionKind,
  }));
}

export async function getPaymentMethodInstructions(
  businessId: string,
  method: PaymentMethodId
): Promise<string | null> {
  const row = await prisma.payment_method_config.findUnique({
    where: {
      business_id_payment_method: {
        business_id: businessId,
        payment_method: method,
      },
    },
    select: { instructions: true },
  });
  return row?.instructions ?? null;
}
