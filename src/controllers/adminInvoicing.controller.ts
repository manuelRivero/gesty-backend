import type { Request, Response } from "express";
import { FiscalInvoiceKind, FiscalInvoiceStatus } from "@prisma/client";
import { BillingProviderTechnicalError, CuitNotFoundError } from "../domain/invoicing/types";
import {
  checkFiscalConfigurationConnectivity,
  getFiscalConfiguration,
  InvalidFiscalConfigurationError,
  upsertFiscalConfiguration,
} from "../services/invoicing/fiscalConfiguration.service";
import { InvalidCuitError, lookupCuit, NoCentralProviderError } from "../services/invoicing/cuitLookup.service";
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
import {
  ensureEmisorProvisioned,
  provisionAfterFiscalSave,
  syncProviderCondicionIva,
} from "../services/invoicing/emisorProvisioning.service";
import { resolveBillingProvider } from "../services/invoicing/billingProviderFactory";
import { sistemas360HealthArca } from "../services/invoicing/providers/sistemas360Client";
import { BillingLockTimeoutError, BillingLockUnavailableError } from "../services/billing/billingLock";
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

/**
 * Guarda los datos fiscales y, como una SEGUNDA operación independiente (con su propio lock —
 * ver `provisionAfterFiscalSave`), dispara el aprovisionamiento automático del emisor. El
 * guardado ya se persistió para el momento en que se llama a `provisionAfterFiscalSave`: un
 * fallo ahí nunca se informa como si los datos fiscales no se hubieran guardado.
 */
export async function putFiscalConfigurationHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  try {
    await upsertFiscalConfiguration(businessId, {
      cuit: String(req.body.cuit ?? ""),
      razonSocial: String(req.body.razonSocial ?? ""),
      condicionIva: String(req.body.condicionIva ?? ""),
      domicilioFiscal: String(req.body.domicilioFiscal ?? ""),
      autoIssueOnline: Boolean(req.body.autoIssueOnline ?? true),
      autoIssueCash: Boolean(req.body.autoIssueCash ?? false),
    });
  } catch (err) {
    if (err instanceof InvalidFiscalConfigurationError) {
      res.status(400).json({ error: err.message, details: err.errors });
      return;
    }
    throw err;
  }

  const provisioning = await provisionAfterFiscalSave(businessId);
  const config = await getFiscalConfiguration(businessId);
  res.json({ fiscalConfiguration: config, provisioning });
}

/**
 * Fuerza una resincronización del cache informativo `provider_condicion_iva` (ver
 * `syncProviderCondicionIva`) — para que el admin pueda confirmar desde `/settings` qué tiene
 * registrado HOY el proveedor para el emisor, sin tener que esperar a la próxima emisión real.
 */
export async function postSyncProviderCondicionIvaHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  const providerCondicionIva = await syncProviderCondicionIva(businessId);
  const config = await getFiscalConfiguration(businessId);
  res.json({ providerCondicionIva, fiscalConfiguration: config });
}

/**
 * Consulta de solo lectura al padrón por CUIT (FASE: cierre de integración, autocompletar el
 * formulario fiscal). Nunca registra un emisor — eso sigue siendo exclusivo de
 * `postProvisionEmisorHandler`, que el frontend dispara en un paso de confirmación aparte.
 */
export async function getCuitLookupHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  try {
    const result = await lookupCuit(businessId, String(req.params.cuit ?? ""));
    res.json({ cuitLookup: result });
  } catch (err) {
    if (err instanceof InvalidCuitError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof CuitNotFoundError) {
      res.status(404).json({ error: err.message });
      return;
    }
    if (err instanceof NoCentralProviderError) {
      res.status(409).json({ error: err.message });
      return;
    }
    if (err instanceof BillingProviderTechnicalError) {
      res.status(502).json({ error: err.message });
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

/** Filtro por período (`dateFrom`/`dateTo`, "YYYY-MM-DD"): mismo nombrado y convención que `adminOrders`/`adminReservations`. */
export async function listInvoicesHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;

  const statusParam = req.query.status;
  if (
    typeof statusParam === "string" &&
    !Object.values(FiscalInvoiceStatus).includes(statusParam as FiscalInvoiceStatus)
  ) {
    res.status(400).json({ error: "Estado inválido." });
    return;
  }

  try {
    const invoices = await listInvoices(businessId, {
      status: typeof statusParam === "string" ? (statusParam as FiscalInvoiceStatus) : undefined,
      dateFrom: typeof req.query.dateFrom === "string" ? req.query.dateFrom : undefined,
      dateTo: typeof req.query.dateTo === "string" ? req.query.dateTo : undefined,
      take: req.query.take ? Number(req.query.take) : undefined,
      skip: req.query.skip ? Number(req.query.skip) : undefined,
    });
    res.json({ invoices });
  } catch (err) {
    if (err instanceof Error && (err.message === "INVALID_DATE_FROM" || err.message === "INVALID_DATE_TO")) {
      res.status(400).json({ error: "Fecha inválida (dateFrom / dateTo)" });
      return;
    }
    throw err;
  }
}

export async function getOrderInvoicesHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  const invoices = await getInvoicesForOrder(businessId, String(req.params.orderId));
  res.json({ invoices });
}

/**
 * Emisión manual desde el dashboard (FASE 7: historial > "Emitir manualmente"). Dispara el mismo
 * aprovisionamiento lazy que la emisión automática (`requestInvoiceEmission` →
 * `ensureEmisorProvisioned`) si el emisor todavía no está asociado — un error técnico del
 * proveedor o el lock ocupado por otra operación del mismo negocio no debe convertirse en un 500
 * genérico sin información.
 */
export async function postEmitOrderInvoiceHandler(req: Request, res: Response): Promise<void> {
  const businessId = businessIdOrThrow(req, res);
  if (!businessId) return;
  try {
    const outcome = await requestInvoiceEmission(businessId, String(req.params.orderId), FiscalInvoiceKind.invoice);
    res.status(outcome.emitted ? 201 : 409).json(outcome);
  } catch (err) {
    if (err instanceof BillingProviderTechnicalError) {
      console.error("[AdminInvoicing] postEmitOrderInvoiceHandler: error técnico del proveedor durante el aprovisionamiento automático", {
        businessId,
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
        cause:
          err.cause instanceof Error
            ? { name: err.cause.name, message: err.cause.message, stack: err.cause.stack }
            : err.cause,
      });
      res.status(502).json({ error: err.message });
      return;
    }
    if (err instanceof BillingLockTimeoutError || err instanceof BillingLockUnavailableError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
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
      // Catch final de la operación: deja constancia server-side de la excepción completa
      // (incluida su `cause` original) antes de responder con el mensaje ya sanitizado al
      // cliente — este catch es el último punto donde esa información todavía existe.
      console.error("[AdminInvoicing] postProvisionEmisorHandler: error técnico del proveedor", {
        businessId,
        errorName: err.name,
        errorMessage: err.message,
        stack: err.stack,
        cause:
          err.cause instanceof Error
            ? { name: err.cause.name, message: err.cause.message, stack: err.cause.stack }
            : err.cause,
      });
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
