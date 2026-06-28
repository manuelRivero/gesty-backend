import { prisma } from '../lib/prisma';

export interface PaymentMethodConfigInput {
  paymentMethod: string;
  label: string;
  adjustmentType: 'PERCENT' | 'FIXED';
  adjustmentValue: number;
  isSurcharge: boolean;
  isActive?: boolean;
}

export interface PaymentMethodConfigDTO {
  id: string;
  paymentMethod: string;
  label: string;
  adjustmentType: string;
  adjustmentValue: number;
  isSurcharge: boolean;
  isActive: boolean;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listAdminPaymentMethodConfigs(
  businessId: string
): Promise<PaymentMethodConfigDTO[]> {
  const rows = await prisma.payment_method_config.findMany({
    where: { business_id: businessId },
    orderBy: { payment_method: 'asc' },
  });
  return rows.map(toDTO);
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
  const row = await prisma.payment_method_config.create({
    data: {
      business_id: businessId,
      payment_method: input.paymentMethod,
      label: input.label,
      adjustment_type: input.adjustmentType,
      adjustment_value: input.adjustmentValue,
      is_surcharge: input.isSurcharge,
      is_active: input.isActive ?? true,
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

  const row = await prisma.payment_method_config.update({
    where: { id },
    data: {
      ...(input.paymentMethod !== undefined && { payment_method: input.paymentMethod }),
      ...(input.label !== undefined && { label: input.label }),
      ...(input.adjustmentType !== undefined && { adjustment_type: input.adjustmentType }),
      ...(input.adjustmentValue !== undefined && { adjustment_value: input.adjustmentValue }),
      ...(input.isSurcharge !== undefined && { is_surcharge: input.isSurcharge }),
      ...(input.isActive !== undefined && { is_active: input.isActive }),
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
  await prisma.payment_method_config.delete({ where: { id } });
  return true;
}
