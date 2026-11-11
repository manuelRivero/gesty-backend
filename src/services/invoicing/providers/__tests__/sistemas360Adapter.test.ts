import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../sistemas360Client", async () => {
  const actual = await vi.importActual<typeof import("../sistemas360Client")>("../sistemas360Client");
  return {
    ...actual,
    sistemas360ListEmisores: vi.fn(),
    sistemas360CreateEmisor: vi.fn(),
    sistemas360GetEmisor: vi.fn(),
    sistemas360GetEstadoFiscal: vi.fn(),
    sistemas360CrearComprobante: vi.fn(),
    sistemas360BuscarPorReferenciaExterna: vi.fn(),
    sistemas360GetComprobante: vi.fn(),
    sistemas360Reintentar: vi.fn(),
    sistemas360DescargarPdf: vi.fn(),
    sistemas360Ping: vi.fn(),
    sistemas360LookupCuit: vi.fn(),
  };
});

import {
  Sistemas360HttpError,
  Sistemas360ResponseShapeError,
  sistemas360BuscarPorReferenciaExterna,
  sistemas360CreateEmisor,
  sistemas360CrearComprobante,
  sistemas360DescargarPdf,
  sistemas360GetEmisor,
  sistemas360ListEmisores,
  sistemas360LookupCuit,
  sistemas360Reintentar,
  sistemas360Ping,
} from "../sistemas360Client";
import { Sistemas360Adapter, sistemas360ValidateToken } from "../sistemas360Adapter";
import { CuitNotFoundError } from "../../../../domain/invoicing/types";
import type { IssueInvoiceRequest } from "../../../../domain/invoicing/types";

function mocked(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

function baseRequest(overrides: Partial<IssueInvoiceRequest> = {}): IssueInvoiceRequest {
  return {
    externalReference: "biz-1:order-1:invoice",
    voucherType: "B",
    issuer: {
      cuit: "20123456786",
      razonSocial: "Restaurante Test",
      condicionIva: "RI",
      domicilioFiscal: "Calle Falsa 123",
      externalIssuerId: "77",
    },
    customer: {
      documentType: "CONSUMIDOR_FINAL",
      documentNumber: null,
      name: "Consumidor Final",
      email: null,
      address: null,
      condicionIva: "CF",
    },
    items: [{ description: "Milanesa", quantity: 1, unitPrice: 1000, vatRate: 21 }],
    totalAmount: 1000,
    currencyCode: "ARS",
    ...overrides,
  };
}

describe("Sistemas360Adapter.registerIssuer", () => {
  it("no intenta crear un emisor si la lista remota tiene un formato inesperado", async () => {
    mocked(sistemas360ListEmisores).mockRejectedValue(
      new Sistemas360ResponseShapeError("La lista de emisores de Sistemas 360 no tiene un formato reconocido.")
    );
    const adapter = new Sistemas360Adapter("central-token");

    await expect(
      adapter.registerIssuer({
        issuer: { cuit: "20123456786", razonSocial: "Test", condicionIva: "RI", domicilioFiscal: "" },
      })
    ).rejects.toThrow(/formato reconocido/);
    expect(sistemas360CreateEmisor).not.toHaveBeenCalled();
  });

  it("explica que la asociación requiere token de cuenta si Sistemas 360 responde 403", async () => {
    mocked(sistemas360ListEmisores).mockRejectedValue(
      new Sistemas360HttpError("Sistemas 360 respondió 403 en /emisores", 403, {
        mensaje_api: "Este endpoint requiere un token de cuenta.",
      })
    );
    const adapter = new Sistemas360Adapter("issuer-token");

    await expect(
      adapter.registerIssuer({
        issuer: { cuit: "20123456786", razonSocial: "Test", condicionIva: "RI", domicilioFiscal: "" },
      })
    ).rejects.toThrow(/SUPER_ADMIN debe configurar un token de cuenta/);
  });

  it("reutiliza un emisor existente por CUIT en vez de crear uno nuevo", async () => {
    mocked(sistemas360ListEmisores).mockResolvedValue([
      { id: 77, cuit: "20123456786", habilitado_produccion: false },
    ]);
    const adapter = new Sistemas360Adapter("central-token");

    const result = await adapter.registerIssuer({
      issuer: {
        cuit: "20-12345678-6",
        razonSocial: "Restaurante Test",
        condicionIva: "RI",
        domicilioFiscal: "",
      },
    });

    expect(sistemas360CreateEmisor).not.toHaveBeenCalled();
    expect(result.externalIssuerId).toBe("77");
    expect(result.status).toBe("pending_validation");
  });

  it("crea un emisor nuevo cuando el CUIT no existe en la cuenta", async () => {
    mocked(sistemas360ListEmisores).mockResolvedValue([]);
    mocked(sistemas360CreateEmisor).mockResolvedValue({ id: 88, cuit: "20123456786" });
    const adapter = new Sistemas360Adapter("central-token");

    const result = await adapter.registerIssuer({
      issuer: { cuit: "20123456786", razonSocial: "Test", condicionIva: "RI", domicilioFiscal: "" },
    });

    expect(sistemas360CreateEmisor).toHaveBeenCalledTimes(1);
    expect(result.externalIssuerId).toBe("88");
  });

  it("rechaza la alta si la respuesta del proveedor no trae un identificador válido (nunca persistir undefined)", async () => {
    mocked(sistemas360ListEmisores).mockResolvedValue([]);
    mocked(sistemas360CreateEmisor).mockResolvedValue({ cuit: "20123456786" });
    const adapter = new Sistemas360Adapter("central-token");

    await expect(
      adapter.registerIssuer({
        issuer: { cuit: "20123456786", razonSocial: "Test", condicionIva: "RI", domicilioFiscal: "" },
      })
    ).rejects.toThrow(/identificador numérico válido/);
  });

  it("prefiere emisor_id sobre id cuando el proveedor devuelve ambos (contrato oficial confirmado)", async () => {
    mocked(sistemas360ListEmisores).mockResolvedValue([]);
    mocked(sistemas360CreateEmisor).mockResolvedValue({ emisor_id: 555, id: 1, cuit: "20123456786" });
    const adapter = new Sistemas360Adapter("central-token");

    const result = await adapter.registerIssuer({
      issuer: { cuit: "20123456786", razonSocial: "Test", condicionIva: "RI", domicilioFiscal: "" },
    });

    expect(result.externalIssuerId).toBe("555");
  });

  it("propaga businessId a cada llamada real del cliente (listado + alta) para atribución de consumo", async () => {
    mocked(sistemas360ListEmisores).mockResolvedValue([]);
    mocked(sistemas360CreateEmisor).mockResolvedValue({ id: 88, cuit: "20123456786" });
    const adapter = new Sistemas360Adapter("central-token", null, "biz-9");

    await adapter.registerIssuer({
      issuer: { cuit: "20123456786", razonSocial: "Test", condicionIva: "RI", domicilioFiscal: "" },
    });

    expect(sistemas360ListEmisores).toHaveBeenCalledWith("central-token", "biz-9");
    expect(sistemas360CreateEmisor).toHaveBeenCalledWith(
      "central-token",
      expect.objectContaining({ cuit: "20123456786" }),
      "biz-9"
    );
  });
});

describe("Sistemas360Adapter.lookupCuit", () => {
  it("consulta el padrón y normaliza la respuesta, sin crear ni listar emisores", async () => {
    mocked(sistemas360LookupCuit).mockResolvedValue({
      cuit: "20123456786",
      razon_social: "Restaurante Test",
      condicion_iva: "Responsable Inscripto",
      domicilio_fiscal: "Calle Falsa 123",
    });
    const adapter = new Sistemas360Adapter("central-token", null, "biz-1");

    const result = await adapter.lookupCuit("20-12345678-6");

    expect(sistemas360LookupCuit).toHaveBeenCalledWith("central-token", "20123456786", "biz-1");
    expect(sistemas360ListEmisores).not.toHaveBeenCalled();
    expect(sistemas360CreateEmisor).not.toHaveBeenCalled();
    expect(result).toEqual({
      cuit: "20123456786",
      razonSocial: "Restaurante Test",
      condicionIva: "RI",
      condicionIvaRaw: "Responsable Inscripto",
      domicilioFiscal: "Calle Falsa 123",
    });
  });

  it("lanza CuitNotFoundError cuando el proveedor responde 404", async () => {
    mocked(sistemas360LookupCuit).mockRejectedValue(
      new Sistemas360HttpError("Sistemas 360 respondió 404 en /cuit/20123456786", 404, {})
    );
    const adapter = new Sistemas360Adapter("central-token");

    await expect(adapter.lookupCuit("20123456786")).rejects.toBeInstanceOf(CuitNotFoundError);
  });

  it("no reconoce una condición de IVA inesperada como RI/CF/etc., pero conserva el valor crudo", async () => {
    mocked(sistemas360LookupCuit).mockResolvedValue({
      cuit: "20123456786",
      condicion_iva: "Algo nuevo no mapeado",
    });
    const adapter = new Sistemas360Adapter("central-token");

    const result = await adapter.lookupCuit("20123456786");

    expect(result.condicionIva).toBe("NO_CATEGORIZADO");
    expect(result.condicionIvaRaw).toBe("Algo nuevo no mapeado");
  });

  it("traduce un error 403 (token sin permisos de cuenta) a error técnico del dominio", async () => {
    mocked(sistemas360LookupCuit).mockRejectedValue(
      new Sistemas360HttpError("Sistemas 360 respondió 403 en /cuit/20123456786", 403, {})
    );
    const adapter = new Sistemas360Adapter("central-token");

    await expect(adapter.lookupCuit("20123456786")).rejects.toThrow(/token de cuenta/);
  });
});

describe("sistemas360ValidateToken", () => {
  it("valida que el token tenga acceso de cuenta a la lista de emisores", async () => {
    mocked(sistemas360ListEmisores).mockResolvedValue([]);

    const result = await sistemas360ValidateToken("account-token");

    expect(sistemas360Ping).toHaveBeenCalledWith("account-token");
    expect(sistemas360ListEmisores).toHaveBeenCalledWith("account-token");
    expect(result).toEqual({
      ok: true,
      detail: "Token de cuenta válido; se pudo consultar la lista de emisores.",
    });
  });

  it("detecta un token sin permisos de cuenta aunque /ping lo acepte", async () => {
    mocked(sistemas360ListEmisores).mockRejectedValue(
      new Sistemas360HttpError("Sistemas 360 respondió 403 en /emisores", 403, {
        mensaje_api: "Este endpoint requiere un token de cuenta.",
      })
    );

    const result = await sistemas360ValidateToken("issuer-token");

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no tiene permisos de cuenta/);
    expect(result.detail).toMatch(/SUPER_ADMIN/);
  });
});

describe("Sistemas360Adapter.issueInvoice", () => {
  it("incluye emisor_id en el payload cuando viene en el request", async () => {
    mocked(sistemas360CrearComprobante).mockResolvedValue({
      ok: true,
      data: { id: 1, entorno: "pruebas", modo_simulacion: true, estado: "autorizado", tipo_comprobante: "factura_b", cae: "71234567890123" },
    });
    // Construido CON businessId para demostrar que, aun así, `crearComprobante` no lo propaga
    // al cliente — ver siguiente aserción.
    const adapter = new Sistemas360Adapter("central-token", null, "biz-1");

    await adapter.issueInvoice(baseRequest());

    expect(sistemas360CrearComprobante).toHaveBeenCalledWith(
      "central-token",
      expect.objectContaining({ emisor_id: 77, referencia_externa: "biz-1:order-1:invoice" })
    );
    expect(mocked(sistemas360CrearComprobante).mock.calls[0][1]).not.toHaveProperty("punto_venta");
    // No se pasa `businessId` a `sistemas360CrearComprobante`: `invoice.service.ts` (`runIssue`)
    // ya contabiliza esta MISMA llamada a nivel de negocio — pasarlo también aquí duplicaría esa
    // atribución (hallazgo "instrumentación real de requests", "no contabilizar dos veces").
    expect(mocked(sistemas360CrearComprobante).mock.calls[0]).toHaveLength(2);
  });

  it("manda el precio NETO (sin IVA) por ítem, nunca el bruto con `precios_incluyen_iva` — confirmado contra sandbox que Sistemas 360 recalcula el total sumando IVA sin importar ese flag", async () => {
    mocked(sistemas360CrearComprobante).mockResolvedValue({
      ok: true,
      data: { id: 1, entorno: "pruebas", modo_simulacion: true, estado: "autorizado", tipo_comprobante: "factura_b", cae: "71234567890123" },
    });
    const adapter = new Sistemas360Adapter("central-token", null);

    await adapter.issueInvoice(baseRequest());

    const payload = mocked(sistemas360CrearComprobante).mock.calls[0][1];
    expect(payload.items).toEqual([
      {
        descripcion: "Milanesa",
        cantidad: 1,
        precio_unitario: 826.45, // 1000 / 1.21, redondeado a 2 decimales
        tipo_impuesto: "gravado",
        iva: 21,
      },
    ]);
  });

  it("factura C no manda desglose de IVA por ítem (precio bruto tal cual)", async () => {
    mocked(sistemas360CrearComprobante).mockResolvedValue({
      ok: true,
      data: { id: 1, entorno: "pruebas", modo_simulacion: true, estado: "autorizado", tipo_comprobante: "factura_c", cae: "71234567890123" },
    });
    const adapter = new Sistemas360Adapter("central-token", null);

    await adapter.issueInvoice(baseRequest({ voucherType: "C" }));

    const payload = mocked(sistemas360CrearComprobante).mock.calls[0][1];
    expect(payload.items).toEqual([{ descripcion: "Milanesa", cantidad: 1, precio_unitario: 1000 }]);
  });
});

describe("Sistemas360Adapter.getInvoiceStatus", () => {
  it("escala a /reintentar cuando el estado remoto es 'pendiente_confirmacion' (nunca reemite)", async () => {
    mocked(sistemas360BuscarPorReferenciaExterna).mockResolvedValue({
      id: 1,
      entorno: "pruebas",
      modo_simulacion: true,
      estado: "pendiente_confirmacion",
      tipo_comprobante: "factura_b",
    });
    mocked(sistemas360Reintentar).mockResolvedValue({
      ok: true,
      data: { id: 1, entorno: "pruebas", modo_simulacion: true, estado: "autorizado", tipo_comprobante: "factura_b", cae: "71234567890123" },
    });
    const adapter = new Sistemas360Adapter("central-token");

    const result = await adapter.getInvoiceStatus("biz-1:order-1:invoice");

    expect(sistemas360Reintentar).toHaveBeenCalledWith("central-token", 1, undefined);
    expect(result.status).toBe("authorized");
  });

  it("escala a /reintentar cuando el estado remoto es 'error'", async () => {
    mocked(sistemas360BuscarPorReferenciaExterna).mockResolvedValue({
      id: 2,
      entorno: "pruebas",
      modo_simulacion: true,
      estado: "error",
      tipo_comprobante: "factura_b",
    });
    mocked(sistemas360Reintentar).mockResolvedValue({
      ok: true,
      data: { id: 2, entorno: "pruebas", modo_simulacion: true, estado: "autorizado", tipo_comprobante: "factura_b", cae: "71234567890124" },
    });
    const adapter = new Sistemas360Adapter("central-token");

    await adapter.getInvoiceStatus("biz-1:order-2:invoice");

    expect(sistemas360Reintentar).toHaveBeenCalledWith("central-token", 2, undefined);
  });

  it("NO escala a /reintentar cuando el estado remoto ya es terminal (autorizado)", async () => {
    mocked(sistemas360BuscarPorReferenciaExterna).mockResolvedValue({
      id: 3,
      entorno: "pruebas",
      modo_simulacion: true,
      estado: "autorizado",
      tipo_comprobante: "factura_b",
      cae: "71234567890125",
    });
    const adapter = new Sistemas360Adapter("central-token");

    const result = await adapter.getInvoiceStatus("biz-1:order-3:invoice");

    expect(sistemas360Reintentar).not.toHaveBeenCalled();
    expect(result.status).toBe("authorized");
  });

  it("devuelve requires_review si no encuentra el comprobante por referencia externa (sin reemitir)", async () => {
    mocked(sistemas360BuscarPorReferenciaExterna).mockResolvedValue(null);
    const adapter = new Sistemas360Adapter("central-token");

    const result = await adapter.getInvoiceStatus("biz-1:order-4:invoice");

    expect(result.status).toBe("requires_review");
  });
});

describe("Sistemas360Adapter.getInvoicePdf", () => {
  it("descarga el PDF autenticado y lo devuelve como data URL (nunca una URL pública)", async () => {
    mocked(sistemas360BuscarPorReferenciaExterna).mockResolvedValue({ id: 5, entorno: "pruebas", modo_simulacion: true, estado: "autorizado", tipo_comprobante: "factura_b" });
    mocked(sistemas360DescargarPdf).mockResolvedValue(Buffer.from("PDF-DATA"));
    const adapter = new Sistemas360Adapter("central-token");

    const pdfUrl = await adapter.getInvoicePdf("biz-1:order-5:invoice");

    expect(pdfUrl).toMatch(/^data:application\/pdf;base64,/);
  });

  it("devuelve null si no encuentra el comprobante", async () => {
    mocked(sistemas360BuscarPorReferenciaExterna).mockResolvedValue(null);
    const adapter = new Sistemas360Adapter("central-token");

    expect(await adapter.getInvoicePdf("biz-1:order-6:invoice")).toBeNull();
  });
});

describe("getIssuerCondicionIva", () => {
  it("devuelve NO_CATEGORIZADO sin consultar al proveedor si no hay emisor vinculado", async () => {
    const adapter = new Sistemas360Adapter("central-token", null, "biz-1");

    const result = await adapter.getIssuerCondicionIva();

    expect(result).toBe("NO_CATEGORIZADO");
    expect(sistemas360GetEmisor).not.toHaveBeenCalled();
  });

  it("consulta el emisor vinculado y normaliza su condición de IVA (nunca la local)", async () => {
    mocked(sistemas360GetEmisor).mockResolvedValue({
      emisor_id: 310,
      cuit: "30990100019",
      condicion_iva: "responsable_inscripto",
    });
    const adapter = new Sistemas360Adapter("central-token", 310, "biz-1");

    const result = await adapter.getIssuerCondicionIva();

    expect(result).toBe("RI");
    expect(sistemas360GetEmisor).toHaveBeenCalledWith("central-token", 310, "biz-1");
  });

  it("propaga un error técnico si Sistemas 360 falla al consultar el emisor", async () => {
    mocked(sistemas360GetEmisor).mockRejectedValue(new Sistemas360HttpError("falló", 500, null));
    const adapter = new Sistemas360Adapter("central-token", 310, "biz-1");

    await expect(adapter.getIssuerCondicionIva()).rejects.toThrow();
  });
});
