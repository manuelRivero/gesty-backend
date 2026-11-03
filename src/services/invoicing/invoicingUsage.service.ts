import { prisma } from "../../lib/prisma";
import type { invoicing_usage_period } from "@prisma/client";
import { getInvoicingAddon } from "./invoicingAddon.service";

function currentPeriod(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Registra un request técnico contra el proveedor (emisión, consulta, reintento). No representa
 * consumo facturable por sí solo — ver `recordVoucherAuthorized` para lo que sí se cobra (FASE 6:
 * no cobrar validaciones/reintentos, solo comprobantes autorizados).
 */
export async function recordProviderRequest(businessId: string, period = currentPeriod()): Promise<void> {
  // Misma moneda que usa `recordVoucherAuthorized` para el período (la del add-on configurado):
  // evita que el período quede etiquetado "USD" solo porque este contador corre primero.
  const addon = await getInvoicingAddon(businessId);
  const currency = addon?.currency_code ?? "USD";

  await prisma.invoicing_usage_period.upsert({
    where: { business_id_period: { business_id: businessId, period } },
    create: { business_id: businessId, period, provider_requests: 1, currency_code: currency },
    update: { provider_requests: { increment: 1 }, updated_at: new Date() },
  });
}

/**
 * Registra un comprobante autorizado y acumula costo del proveedor / importe comercial calculado
 * con la configuración vigente del complemento. No ejecuta ningún cobro (ver FASE 6: dejar el
 * consumo registrado y el importe calculable, sin cobro automático).
 */
export async function recordVoucherAuthorized(
  businessId: string,
  period = currentPeriod()
): Promise<invoicing_usage_period> {
  const addon = await getInvoicingAddon(businessId);
  const providerCost = addon?.provider_cost_per_voucher ? Number(addon.provider_cost_per_voucher) : 0;
  const commercialPrice = addon?.price_per_voucher ? Number(addon.price_per_voucher) : 0;
  const currency = addon?.currency_code ?? "USD";

  return prisma.invoicing_usage_period.upsert({
    where: { business_id_period: { business_id: businessId, period } },
    create: {
      business_id: businessId,
      period,
      vouchers_authorized: 1,
      provider_cost_total: providerCost,
      commercial_amount_total: commercialPrice,
      currency_code: currency,
    },
    update: {
      vouchers_authorized: { increment: 1 },
      provider_cost_total: { increment: providerCost },
      commercial_amount_total: { increment: commercialPrice },
      updated_at: new Date(),
    },
  });
}

export async function getUsageForPeriod(
  businessId: string,
  period = currentPeriod()
): Promise<invoicing_usage_period | null> {
  return prisma.invoicing_usage_period.findUnique({ where: { business_id_period: { business_id: businessId, period } } });
}

export async function listUsageHistory(businessId: string): Promise<invoicing_usage_period[]> {
  return prisma.invoicing_usage_period.findMany({
    where: { business_id: businessId },
    orderBy: { period: "desc" },
  });
}
