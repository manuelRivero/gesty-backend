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
  provisionAfterFiscalSave: vi.fn(),
}));

vi.mock("../../services/billing/billingLock", () => ({
  BillingLockTimeoutError: class extends Error {},
  BillingLockUnavailableError: class extends Error {},
}));

vi.mock("../../services/invoicing/centralProviderConfig.service", () => ({
  getActiveCentralToken: vi.fn(),
}));

vi.mock("../../services/invoicing/providers/sistemas360Client", () => ({
  sistemas360HealthArca: vi.fn(),
}));

vi.mock("../../services/invoicing/cuitLookup.service", () => ({
  lookupCuit: vi.fn(),
  InvalidCuitError: class extends Error {},
  NoCentralProviderError: class extends Error {},
}));

import { prisma } from "../../lib/prisma";
import { BillingProviderTechnicalError, CuitNotFoundError } from "../../domain/invoicing/types";
import { BillingLockTimeoutError } from "../../services/billing/billingLock";
import { resolveBillingProvider } from "../../services/invoicing/billingProviderFactory";
import { ensureEmisorProvisioned, provisionAfterFiscalSave } from "../../services/invoicing/emisorProvisioning.service";
import {
  InvalidFiscalConfigurationError,
  upsertFiscalConfiguration,
  getFiscalConfiguration,
} from "../../services/invoicing/fiscalConfiguration.service";
import { requestInvoiceEmission } from "../../services/invoicing/invoice.service";
import { InvalidCuitError, lookupCuit, NoCentralProviderError } from "../../services/invoicing/cuitLookup.service";
import {
  getCuitLookupHandler,
  getOrderInvoicePdfHandler,
  postEmitOrderInvoiceHandler,
  postProvisionEmisorHandler,
  putFiscalConfigurationHandler,
} from "../adminInvoicing.controller";

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

describe("getCuitLookupHandler", () => {
  function makeCuitLookupRequest(cuit: string): Request {
    return { user: { businessId: "business-1" }, params: { cuit } } as unknown as Request;
  }

  it("devuelve el resultado normalizado de la consulta", async () => {
    mocked(lookupCuit).mockResolvedValue({
      cuit: "20123456786",
      razonSocial: "Restaurante Test",
      condicionIva: "RI",
      condicionIvaRaw: "Responsable Inscripto",
      domicilioFiscal: "Calle Falsa 123",
    });
    const res = makeResponse();

    await getCuitLookupHandler(makeCuitLookupRequest("20123456786"), res);

    expect(lookupCuit).toHaveBeenCalledWith("business-1", "20123456786");
    expect(res.json).toHaveBeenCalledWith({
      cuitLookup: {
        cuit: "20123456786",
        razonSocial: "Restaurante Test",
        condicionIva: "RI",
        condicionIvaRaw: "Responsable Inscripto",
        domicilioFiscal: "Calle Falsa 123",
      },
    });
  });

  it("devuelve 400 cuando el CUIT no es válido", async () => {
    mocked(lookupCuit).mockRejectedValue(new InvalidCuitError());
    const res = makeResponse();

    await getCuitLookupHandler(makeCuitLookupRequest("123"), res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("devuelve 404 cuando el CUIT no existe en el padrón", async () => {
    mocked(lookupCuit).mockRejectedValue(new CuitNotFoundError("20123456786"));
    const res = makeResponse();

    await getCuitLookupHandler(makeCuitLookupRequest("20123456786"), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("devuelve 409 cuando no hay token central activo", async () => {
    mocked(lookupCuit).mockRejectedValue(new NoCentralProviderError());
    const res = makeResponse();

    await getCuitLookupHandler(makeCuitLookupRequest("20123456786"), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("devuelve 502 ante un error técnico del proveedor", async () => {
    mocked(lookupCuit).mockRejectedValue(
      new BillingProviderTechnicalError("sistemas360", "Sistemas 360 respondió 500 en /cuit/20123456786", null)
    );
    const res = makeResponse();

    await getCuitLookupHandler(makeCuitLookupRequest("20123456786"), res);

    expect(res.status).toHaveBeenCalledWith(502);
  });
});

describe("putFiscalConfigurationHandler", () => {
  function makePutRequest(body: Record<string, unknown>): Request {
    return { user: { businessId: "business-1" }, params: {}, body } as unknown as Request;
  }

  const inputBody = {
    cuit: "20123456786",
    razonSocial: "Restaurante Test",
    condicionIva: "RI",
    domicilioFiscal: "Calle Falsa 123",
    autoIssueOnline: true,
    autoIssueCash: false,
  };

  it("guarda primero y dispara el aprovisionamiento como una segunda operación, incluido en la respuesta", async () => {
    mocked(upsertFiscalConfiguration).mockResolvedValue({ business_id: "business-1" });
    mocked(getFiscalConfiguration).mockResolvedValue({
      business_id: "business-1",
      external_issuer_id: "99",
    });
    mocked(provisionAfterFiscalSave).mockResolvedValue({ outcome: "provisioned", detail: "Ya asociado." });
    const res = makeResponse();

    await putFiscalConfigurationHandler(makePutRequest(inputBody), res);

    expect(upsertFiscalConfiguration).toHaveBeenCalledWith("business-1", inputBody);
    expect(provisionAfterFiscalSave).toHaveBeenCalledWith("business-1");
    // El orden importa: el aprovisionamiento se dispara DESPUÉS de que el guardado ya resolvió.
    expect(mocked(upsertFiscalConfiguration).mock.invocationCallOrder[0]).toBeLessThan(
      mocked(provisionAfterFiscalSave).mock.invocationCallOrder[0]
    );
    expect(res.json).toHaveBeenCalledWith({
      fiscalConfiguration: { business_id: "business-1", external_issuer_id: "99" },
      provisioning: { outcome: "provisioned", detail: "Ya asociado." },
    });
  });

  it("un aprovisionamiento 'pending'/'requires_attention' nunca aparenta que el guardado falló", async () => {
    mocked(upsertFiscalConfiguration).mockResolvedValue({ business_id: "business-1" });
    mocked(getFiscalConfiguration).mockResolvedValue({ business_id: "business-1", external_issuer_id: null });
    mocked(provisionAfterFiscalSave).mockResolvedValue({
      outcome: "requires_attention",
      detail: "El emisor ya está asociado a otro negocio.",
    });
    const res = makeResponse();

    await putFiscalConfigurationHandler(makePutRequest(inputBody), res);

    // Nunca un status de error: los datos fiscales se guardaron correctamente.
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        provisioning: { outcome: "requires_attention", detail: "El emisor ya está asociado a otro negocio." },
      })
    );
  });

  it("un dato fiscal inválido no llega a intentar el aprovisionamiento", async () => {
    mocked(upsertFiscalConfiguration).mockRejectedValue(
      new InvalidFiscalConfigurationError(["El CUIT no es válido."])
    );
    const res = makeResponse();

    await putFiscalConfigurationHandler(makePutRequest({ ...inputBody, cuit: "123" }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(provisionAfterFiscalSave).not.toHaveBeenCalled();
  });
});

describe("postEmitOrderInvoiceHandler", () => {
  it("convierte un error técnico del proveedor durante el aprovisionamiento automático en 502 sanitizado", async () => {
    mocked(requestInvoiceEmission).mockRejectedValue(
      new BillingProviderTechnicalError("sistemas360", "Sistemas 360 respondió 500 en /emisores", null)
    );
    const res = makeResponse();

    await postEmitOrderInvoiceHandler(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(502);
    expect(res.json).toHaveBeenCalledWith({
      error: "[sistemas360] Error técnico: Sistemas 360 respondió 500 en /emisores",
    });
  });

  it("convierte un lock ocupado en 409 en vez de un 500 genérico", async () => {
    mocked(requestInvoiceEmission).mockRejectedValue(new BillingLockTimeoutError());
    const res = makeResponse();

    await postEmitOrderInvoiceHandler(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("responde 201 cuando la emisión se autoriza", async () => {
    mocked(requestInvoiceEmission).mockResolvedValue({ emitted: true });
    const res = makeResponse();

    await postEmitOrderInvoiceHandler(makeRequest(), res);

    expect(res.status).toHaveBeenCalledWith(201);
  });
});
