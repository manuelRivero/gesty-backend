import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

vi.mock("../../lib/prisma", () => ({
  prisma: {
    fiscal_invoice: { findFirst: vi.fn() },
  },
}));

vi.mock("../../services/invoicing/billingProviderFactory", () => ({
  resolveBillingProvider: vi.fn(),
}));

vi.mock("../../services/invoicing/fiscalConfiguration.service", () => ({
  checkFiscalConfigurationConnectivity: vi.fn(),
  getFiscalConfiguration: vi.fn(),
  InvalidFiscalConfigurationError: class extends Error {},
  upsertFiscalConfiguration: vi.fn(),
}));

vi.mock("../../services/invoicing/invoicingAddon.service", () => ({
  getInvoicingAddon: vi.fn(),
  setInvoicingAddonEnabled: vi.fn(),
}));

vi.mock("../../services/invoicing/invoicingUsage.service", () => ({
  getUsageForPeriod: vi.fn(),
  listUsageHistory: vi.fn(),
}));

vi.mock("../../services/invoicing/invoice.service", () => ({
  getInvoicesForOrder: vi.fn(),
  listInvoices: vi.fn(),
  requestInvoiceEmission: vi.fn(),
}));

vi.mock("../../services/invoicing/emisorProvisioning.service", () => ({
  ensureEmisorProvisioned: vi.fn(),
}));

vi.mock("../../services/invoicing/centralProviderConfig.service", () => ({
  getActiveCentralToken: vi.fn(),
}));

vi.mock("../../services/invoicing/providers/sistemas360Client", () => ({
  sistemas360HealthArca: vi.fn(),
}));

import { prisma } from "../../lib/prisma";
import { BillingProviderTechnicalError } from "../../domain/invoicing/types";
import { resolveBillingProvider } from "../../services/invoicing/billingProviderFactory";
import { ensureEmisorProvisioned } from "../../services/invoicing/emisorProvisioning.service";
import { getOrderInvoicePdfHandler, postProvisionEmisorHandler } from "../adminInvoicing.controller";

function mocked(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function makeRequest(): Request {
  return {
    user: { businessId: "business-1" },
    params: { orderId: "order-1", invoiceId: "invoice-1" },
  } as unknown as Request;
}

function makeResponse() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response & typeof res;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getOrderInvoicePdfHandler", () => {
  it("descarga el PDF usando el entorno guardado en el comprobante", async () => {
    mocked(prisma.fiscal_invoice.findFirst).mockResolvedValue({
      id: "invoice-1",
      business_id: "business-1",
      order_id: "order-1",
      provider_environment: "sandbox",
      idempotency_key: "business-1:order-1:invoice",
      pdf_url: null,
    });
    const getInvoicePdf = vi.fn().mockResolvedValue("data:application/pdf;base64,abc");
    mocked(resolveBillingProvider).mockResolvedValue({ getInvoicePdf });
    const res = makeResponse();

    await getOrderInvoicePdfHandler(makeRequest(), res);

    expect(resolveBillingProvider).toHaveBeenCalledWith("business-1", {
      environment: "sandbox",
    });
    expect(getInvoicePdf).toHaveBeenCalledWith("business-1:order-1:invoice");
    expect(res.json).toHaveBeenCalledWith({
      pdfDataUrl: "data:application/pdf;base64,abc",
    });
  });

  describe("postProvisionEmisorHandler", () => {
    it("devuelve un error accionable cuando el token central no es de cuenta", async () => {
      mocked(ensureEmisorProvisioned).mockRejectedValue(
        new BillingProviderTechnicalError(
          "sistemas360",
          "El token configurado no tiene permisos de cuenta. SUPER_ADMIN debe configurar un token de cuenta.",
          new Error("403")
        )
      );
      const res = makeResponse();

      await postProvisionEmisorHandler(makeRequest(), res);

      expect(res.status).toHaveBeenCalledWith(502);
      expect(res.json).toHaveBeenCalledWith({
        error:
          "[sistemas360] Error técnico: El token configurado no tiene permisos de cuenta. " +
          "SUPER_ADMIN debe configurar un token de cuenta.",
      });
    });
  });
});
