import { prisma } from '../lib/prisma';
import { isPaymentMethodId } from '../domain/payment/paymentMethods';
import {
  PaymentMethodCombinationError,
  assertCashAllowedWithExternalDelivery,
  assertValidPaymentMethodCombination,
  projectActiveMethodsAfterChange,
} from '../domain/payment/paymentMethodRules';
import { getBusinessConfig } from './businessConfig.service';
import {
  ensureDefaultPaymentMethodConfigs,
  getPaymentMethodCatalogForAdmin,
  listActivePaymentMethodSnapshots,
} from './paymentMethods.service';

export interface PaymentMethodConfigInput {
  paymentMethod: string;
  label: string;
  adjustmentType: 'PERCENT' | 'FIXED';
  adjustmentValue: number;
  isSurcharge: boolean;
  isActive?: boolean;
  instructions?: string | null;
  sortOrder?: number;
}

export interface PaymentMethodConfigDTO {
  id: string;
  paymentMethod: string;
  label: string;
  adjustmentType: string;
  adjustmentValue: number;
  isSurcharge: boolean;
  isActive: boolean;
  instructions: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

function toDTO(row: {
  id: string;
  payment_method: string;
  label: string;
  adjustment_type: string;
  adjustment_value: { toNumber(): number };
  is_surcharge: boolean;
  is_active: boolean;
  instructions: string | null;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}): PaymentMethodConfigDTO {
  return {
    id: row.id,
    paymentMethod: row.payment_method,
    label: row.label,
    adjustmentType: row.adjustment_type,
    adjustmentValue: row.adjustment_value.toNumber(),
    isSurcharge: row.is_surcharge,
    isActive: row.is_active,
    instructions: row.instructions,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function assertCombinationForBusiness(
  businessId: string,
  projected: Array<{ paymentMethod: string; isActive: boolean }>
): Promise<void> {
  const config = await getBusinessConfig(businessId);
  assertValidPaymentMethodCombination({
    activeMethods: projected,
    externalDeliveryEnabled: config.external_delivery_enabled,
  });
}

export async function listAdminPaymentMethodConfigs(
  businessId: string
): Promise<{
  configs: PaymentMethodConfigDTO[];
  catalog: ReturnType<typeof getPaymentMethodCatalogForAdmin>;
}> {
  await ensureDefaultPaymentMethodConfigs(businessId);
  const rows = await prisma.payment_method_config.findMany({
    where: { business_id: businessId },
    orderBy: [{ sort_order: 'asc' }, { payment_method: 'asc' }],
  });
  return {
    configs: rows.map(toDTO),
    catalog: getPaymentMethodCatalogForAdmin(),
  };
}

export async function getAdminPaymentMethodConfigById(
  businessId: string,
  id: string
): Promise<PaymentMethodConfigDTO | null> {
  const row = await prisma.payment_method_config.findFirst({
    where: { id, business_id: businessId },
  });
  return row ? toDTO(row) : null;
}

export async function createAdminPaymentMethodConfig(
  businessId: string,
  input: PaymentMethodConfigInput
): Promise<PaymentMethodConfigDTO> {
  if (!isPaymentMethodId(input.paymentMethod)) {
    throw new PaymentMethodCombinationError(
      `Método de pago inválido: "${input.paymentMethod}". Valores: cash, online, transfer`
    );
  }

  const isActive = input.isActive ?? true;
  const config = await getBusinessConfig(businessId);
  assertCashAllowedWithExternalDelivery(input.paymentMethod, config.external_delivery_enabled);

  const current = await listActivePaymentMethodSnapshots(businessId);
  const projected = projectActiveMethodsAfterChange({
    current,
    change: {
      type: 'upsert',
      paymentMethod: input.paymentMethod,
      isActive,
    },
  });
  await assertCombinationForBusiness(businessId, projected);

  const row = await prisma.payment_method_config.create({
    data: {
      business_id: businessId,
      payment_method: input.paymentMethod,
      label: input.label,
      adjustment_type: input.adjustmentType,
      adjustment_value: input.adjustmentValue,
      is_surcharge: input.isSurcharge,
      is_active: isActive,
      instructions: input.instructions ?? null,
      sort_order: input.sortOrder ?? 0,
    },
  });
  return toDTO(row);
}

export async function updateAdminPaymentMethodConfig(
  businessId: string,
  id: string,
  input: Partial<PaymentMethodConfigInput>
): Promise<PaymentMethodConfigDTO | null> {
  const existing = await prisma.payment_method_config.findFirst({
    where: { id, business_id: businessId },
  });
  if (!existing) return null;

  const nextMethod = input.paymentMethod ?? existing.payment_method;
  if (!isPaymentMethodId(nextMethod)) {
    throw new PaymentMethodCombinationError(
      `Método de pago inválido: "${nextMethod}". Valores: cash, online, transfer`
    );
  }

  const nextActive = input.isActive ?? existing.is_active;
  const config = await getBusinessConfig(businessId);
  if (nextActive) {
    assertCashAllowedWithExternalDelivery(nextMethod, config.external_delivery_enabled);
  }

  const current = await listActivePaymentMethodSnapshots(businessId);
  // Si cambia el payment_method, proyectar delete del viejo + upsert del nuevo
  let projected = current;
  if (input.paymentMethod && input.paymentMethod !== existing.payment_method) {
    projected = projectActiveMethodsAfterChange({
      current: projected,
      change: { type: 'delete', paymentMethod: existing.payment_method },
    });
  }
  projected = projectActiveMethodsAfterChange({
    current: projected,
    change: {
      type: 'upsert',
      paymentMethod: nextMethod,
      isActive: nextActive,
    },
  });
  await assertCombinationForBusiness(businessId, projected);

  const row = await prisma.payment_method_config.update({
    where: { id },
    data: {
      ...(input.paymentMethod !== undefined && { payment_method: input.paymentMethod }),
      ...(input.label !== undefined && { label: input.label }),
      ...(input.adjustmentType !== undefined && { adjustment_type: input.adjustmentType }),
      ...(input.adjustmentValue !== undefined && { adjustment_value: input.adjustmentValue }),
      ...(input.isSurcharge !== undefined && { is_surcharge: input.isSurcharge }),
      ...(input.isActive !== undefined && { is_active: input.isActive }),
      ...(input.instructions !== undefined && { instructions: input.instructions }),
      ...(input.sortOrder !== undefined && { sort_order: input.sortOrder }),
      updated_at: new Date(),
    },
  });
  return toDTO(row);
}

export async function deleteAdminPaymentMethodConfig(
  businessId: string,
  id: string
): Promise<boolean> {
  const existing = await prisma.payment_method_config.findFirst({
    where: { id, business_id: businessId },
  });
  if (!existing) return false;

  const current = await listActivePaymentMethodSnapshots(businessId);
  const projected = projectActiveMethodsAfterChange({
    current,
    change: { type: 'delete', paymentMethod: existing.payment_method },
  });
  await assertCombinationForBusiness(businessId, projected);

  await prisma.payment_method_config.delete({ where: { id } });
  return true;
}

export { PaymentMethodCombinationError };
