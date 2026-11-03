import type { Request, Response } from "express";
import { FiscalInvoiceKind } from "@prisma/client";
import { BillingProviderTechnicalError } from "../domain/invoicing/types";
import {
  checkFiscalConfigurationConnectivity,
  getFiscalConfiguration,
  InvalidFiscalConfigurationError,
  upsertFiscalConfiguration,
} from "../services/invoicing/fiscalConfiguration.service";
import {
  getInvoicingAddon,
  setInvoicingAddonEnabled,
} from "../services/invoicing/invoicingAddon.service";
import { getUsageForPeriod, listUsageHistory } from "../services/invoicing/invoicingUsage.service";
import {
  getInvoicesForOrder,
  listInvoices,
  requestInvoiceEmission,
} from "../services/invoicing/invoice.service";
import { ensureEmisorProvisioned } from "../services/invoicing/emisorProvisioning.service";
import { resolveBillingProvider } from "../services/invoicing/billingProviderFactory";
import { sistemas360HealthArca } from "../services/invoicing/providers/sistemas360Client";
import { prisma } from "../lib/prisma";

function businessIdOrThrow(req: Request, res: Response): string | null {
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  return businessId;
}

/** Diagnóstico público de ARCA/WSFE — no requiere SUPER_ADMIN ni expone secretos. */
export async function getArcaHealthHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  res.json(await sistemas360HealthArca());
}

export async function getFiscalConfigurationHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  const config = await getFiscalConfiguration(businessId);
  res.json({ fiscalConfiguration: config });
}

export async function putFiscalConfigurationHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  try {
    const config = await upsertFiscalConfiguration(businessId, {
      cuit: String(req.body.cuit ?? ""),
      razonSocial: String(req.body.razonSocial ?? ""),
      condicionIva: String(req.body.condicionIva ?? ""),
      domicilioFiscal: String(req.body.domicilioFiscal ?? ""),
      autoIssueOnline: Boolean(req.body.autoIssueOnline ?? true),
      autoIssueCash: Boolean(req.body.autoIssueCash ?? false),
    });
    res.json({ fiscalConfiguration: config });
  } catch (err) {
    if (err instanceof InvalidFiscalConfigurationError) {
      res.status(400).json({ error: err.message, details: err.errors });
      return;
    }
    throw err;
  }
}

export async function getIssuerConnectivityHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  const result = await checkFiscalConfigurationConnectivity(businessId);
  res.json(result);
}

export async function getInvoicingAddonHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  const addon = await getInvoicingAddon(businessId);
  res.json({ addon });
}

export async function putInvoicingAddonHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  const addon = await setInvoicingAddonEnabled(businessId, {
    enabled: Boolean(req.body.enabled),
    monthlyVoucherLimit:
      req.body.monthlyVoucherLimit === undefined ? undefined : Number(req.body.monthlyVoucherLimit),
  });
  res.json({ addon });
}

export async function getInvoicingUsageHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  const period = typeof req.query.period === "string" ? req.query.period : undefined;
  const [current, history] = await Promise.all([
    period ? getUsageForPeriod(businessId, period) : getUsageForPeriod(businessId),
    listUsageHistory(businessId),
  ]);
  res.json({ current, history });
}

export async function listInvoicesHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  const invoices = await listInvoices(businessId, {
    take: req.query.take ? Number(req.query.take) : undefined,
    skip: req.query.skip ? Number(req.query.skip) : undefined,
  });
  res.json({ invoices });
}

export async function getOrderInvoicesHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  const invoices = await getInvoicesForOrder(businessId, String(req.params.orderId));
  res.json({ invoices });
}

/** Emisión manual desde el dashboard (FASE 7: historial > "Emitir manualmente"). */
export async function postEmitOrderInvoiceHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  const outcome = await requestInvoiceEmission(businessId, String(req.params.orderId), FiscalInvoiceKind.invoice);
  res.status(outcome.emitted ? 201 : 409).json(outcome);
}

/**
 * Asocia este negocio a su `emisor_id` en la cuenta central del proveedor (hoy: Sistemas 360).
 * Idempotente — ver `emisorProvisioning.service.ts`. No requiere rol superior a OWNER/ADMIN: el
 * negocio no ve ni controla la cuenta central, solo dispara la asociación de SU emisor.
 */
export async function postProvisionEmisorHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  try {
    const result = await ensureEmisorProvisioned(businessId);
    res.status(result.provisioned ? 200 : 409).json(result);
  } catch (err) {
    if (err instanceof BillingProviderTechnicalError) {
      res.status(502).json({ error: err.message });
      return;
    }
    throw err;
  }
}

/**
 * PDF a demanda (FASE: conciliación sin webhooks / descarga de PDF). Para Sistemas 360 no hay
 * URL pública persistida (requiere el Bearer de la cuenta) — se descarga en el momento y se
 * devuelve como data URL; nunca se persiste el binario en `fiscal_invoice`.
 */
export async function getOrderInvoicePdfHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  const invoice = await prisma.fiscal_invoice.findFirst({
    where: { id: String(req.params.invoiceId), business_id: businessId, order_id: String(req.params.orderId) },
  });
  if (!invoice) {
    res.status(404).json({ error: "Comprobante no encontrado." });
    return;
  }
  const provider = await resolveBillingProvider(
    businessId,
    invoice.provider_environment
      ? { environment: invoice.provider_environment as "sandbox" | "production" }
      : undefined
  );
  if (!provider) {
    res.status(409).json({ error: "Sistemas 360 no está configurado o activo." });
    return;
  }
  const pdfDataUrl = invoice.pdf_url ?? (await provider.getInvoicePdf(invoice.idempotency_key));
  if (!pdfDataUrl) {
    res.status(404).json({ error: "El proveedor no tiene un PDF disponible para este comprobante." });
    return;
  }
  res.json({ pdfDataUrl });
}
