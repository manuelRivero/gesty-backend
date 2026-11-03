import { prisma } from "../../lib/prisma";
import type { invoicing_addon } from "@prisma/client";

export async function getInvoicingAddon(businessId: string): Promise<invoicing_addon | null> {
  return prisma.invoicing_addon.findUnique({ where: { business_id: businessId } });
}

export async function isInvoicingAddonEnabled(businessId: string): Promise<boolean> {
  const addon = await getInvoicingAddon(businessId);
  return addon?.enabled === true;
}

export interface SetInvoicingAddonInput {
  enabled: boolean;
  monthlyVoucherLimit?: number | null;
}

/** Activa/desactiva el complemento. No crea ni modifica la suscripción base de Gesty. */
export async function setInvoicingAddonEnabled(
  businessId: string,
  input: SetInvoicingAddonInput
): Promise<invoicing_addon> {
  return prisma.invoicing_addon.upsert({
    where: { business_id: businessId },
    create: {
      business_id: businessId,
      enabled: input.enabled,
      monthly_voucher_limit: input.monthlyVoucherLimit ?? null,
      activated_at: input.enabled ? new Date() : null,
    },
    update: {
      enabled: input.enabled,
      ...(input.monthlyVoucherLimit !== undefined
        ? { monthly_voucher_limit: input.monthlyVoucherLimit }
        : {}),
      activated_at: input.enabled ? new Date() : undefined,
      updated_at: new Date(),
    },
  });
}

/**
 * Configuración comercial (precio/costo por comprobante). Solo superadmin la modifica —
 * ver controller. Null en price/cost significa "no definido todavía" (FASE 6: no inventar tarifas).
 */
export async function setInvoicingAddonPricing(
  businessId: string,
  pricePerVoucher: number | null,
  providerCostPerVoucher: number | null,
  currencyCode: string
): Promise<invoicing_addon> {
  return prisma.invoicing_addon.upsert({
    where: { business_id: businessId },
    create: {
      business_id: businessId,
      enabled: false,
      price_per_voucher: pricePerVoucher,
      provider_cost_per_voucher: providerCostPerVoucher,
      currency_code: currencyCode,
    },
    update: {
      price_per_voucher: pricePerVoucher,
      provider_cost_per_voucher: providerCostPerVoucher,
      currency_code: currencyCode,
      updated_at: new Date(),
    },
  });
}
