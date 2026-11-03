import type { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { setInvoicingAddonPricing } from "../services/invoicing/invoicingAddon.service";

/** Restaurantes con el add-on de facturación activo, para panel de superadmin (FASE 8). */
export async function listBusinessesWithInvoicingHandler(_req: Request, res: Response): Promise<void> {
  const addons = await prisma.invoicing_addon.findMany({
    where: { enabled: true },
    include: { business: { select: { id: true, name: true } } },
  });
  res.json({ businesses: addons });
}

/** Consumo global del período actual, para diagnóstico/costeo agregado. */
export async function getGlobalInvoicingUsageHandler(req: Request, res: Response): Promise<void> {
  const period =
    typeof req.query.period === "string"
      ? req.query.period
      : `${new Date().getUTCFullYear()}-${String(new Date().getUTCMonth() + 1).padStart(2, "0")}`;
  const rows = await prisma.invoicing_usage_period.findMany({
    where: { period },
    include: { business: { select: { id: true, name: true } } },
  });
  res.json({ period, rows });
}

/**
 * Configura precio comercial / costo del proveedor por comprobante para un restaurante.
 * Nunca expone credenciales fiscales en texto plano (ver FASE 9) — este endpoint no las toca.
 */
export async function putGlobalInvoicingPricingHandler(req: Request, res: Response): Promise<void> {
  const { businessId } = req.params;
  const { pricePerVoucher, providerCostPerVoucher, currencyCode } = req.body ?? {};
  const addon = await setInvoicingAddonPricing(
    String(businessId),
    pricePerVoucher === undefined || pricePerVoucher === null ? null : Number(pricePerVoucher),
    providerCostPerVoucher === undefined || providerCostPerVoucher === null
      ? null
      : Number(providerCostPerVoucher),
    String(currencyCode ?? "USD")
  );
  res.json({ addon });
}

/** Comprobantes que requieren revisión manual (rechazados o con resultado desconocido tras timeout). */
export async function listInvoicingIssuesHandler(_req: Request, res: Response): Promise<void> {
  const invoices = await prisma.fiscal_invoice.findMany({
    where: { status: { in: ["rejected", "requires_review", "failed"] } },
    include: { business: { select: { id: true, name: true } } },
    orderBy: { updated_at: "desc" },
    take: 100,
  });
  res.json({ invoices });
}
