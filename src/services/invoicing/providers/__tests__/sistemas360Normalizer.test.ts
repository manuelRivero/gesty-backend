import { describe, expect, it } from "vitest";
import {
  condicionIvaToReceptorId,
  normalizeCondicionIvaFromPadron,
  normalizeSistemas360Response,
  voucherTypeToTipoComprobante,
} from "../sistemas360Normalizer";
import type { Sistemas360ComprobanteResponse } from "../sistemas360Client";

function buildResponse(
  overrides: Partial<Sistemas360ComprobanteResponse["data"]> = {}
): Sistemas360ComprobanteResponse {
  return {
    ok: true,
    mensaje: null,
    mensaje_api: null,
    data: {
      id: 123,
      entorno: "pruebas",
      modo_simulacion: true,
      estado: "autorizado",
      tipo_comprobante: "factura_b",
      punto_venta: 3,
      numero_comprobante: 10,
      cae: "71234567890123",
      cae_vencimiento: "2027-01-01",
      referencia_externa: "biz-1:order-1:invoice",
      ...overrides,
    },
  };
}

describe("condicionIvaToReceptorId", () => {
  it("mapea los valores documentados por Sistemas 360", () => {
    expect(condicionIvaToReceptorId("RI")).toBe(1);
    expect(condicionIvaToReceptorId("MONOTRIBUTO")).toBe(6);
    expect(condicionIvaToReceptorId("EXENTO")).toBe(4);
    expect(condicionIvaToReceptorId("CF")).toBe(5);
    expect(condicionIvaToReceptorId("NO_CATEGORIZADO")).toBe(7);
  });
});

describe("voucherTypeToTipoComprobante", () => {
  it("mapea facturas", () => {
    expect(voucherTypeToTipoComprobante("A", false)).toBe("factura_a");
    expect(voucherTypeToTipoComprobante("B", false)).toBe("factura_b");
    expect(voucherTypeToTipoComprobante("C", false)).toBe("factura_c");
  });

  it("mapea notas de crédito", () => {
    expect(voucherTypeToTipoComprobante("B", true)).toBe("nota_credito_b");
  });
});

describe("normalizeSistemas360Response", () => {
  it("mapea 'autorizado' a 'authorized'", () => {
    const result = normalizeSistemas360Response(buildResponse({ estado: "autorizado" }));
    expect(result.status).toBe("authorized");
    expect(result.cae).toBe("71234567890123");
    expect(result.voucherType).toBe("B");
    expect(result.comprobanteNumero).toBe(10);
  });

  it("mapea 'simulado' a 'simulated', NUNCA a 'authorized' (sin validez fiscal real)", () => {
    const result = normalizeSistemas360Response(buildResponse({ estado: "simulado" }));
    expect(result.status).toBe("simulated");
    expect(result.status).not.toBe("authorized");
  });

  it("mapea 'rechazado' a 'rejected' y extrae el mensaje de mensajes_arca", () => {
    const result = normalizeSistemas360Response(
      buildResponse({ estado: "rechazado", cae: null, mensajes_arca: [{ mensaje: "CUIT inválido" }] })
    );
    expect(result.status).toBe("rejected");
    expect(result.errorMessage).toBe("CUIT inválido");
  });

  it("mapea 'error' a 'requires_review' (no a 'failed'): es recuperable vía /reintentar", () => {
    const result = normalizeSistemas360Response(buildResponse({ estado: "error", cae: null }));
    expect(result.status).toBe("requires_review");
  });

  it("mapea 'pendiente_confirmacion' y 'pendiente' a 'processing' (no terminal)", () => {
    expect(normalizeSistemas360Response(buildResponse({ estado: "pendiente_confirmacion", cae: null })).status).toBe(
      "processing"
    );
    expect(normalizeSistemas360Response(buildResponse({ estado: "pendiente", cae: null })).status).toBe("processing");
  });

  it("nunca devuelve una URL de PDF pública (requiere token para descargarse)", () => {
    const result = normalizeSistemas360Response(buildResponse());
    expect(result.pdfUrl).toBeNull();
  });

  it("conserva el providerInvoiceId como string del id numérico de Sistemas 360", () => {
    const result = normalizeSistemas360Response(buildResponse({ id: 999 }));
    expect(result.providerInvoiceId).toBe("999");
  });
});

describe("normalizeCondicionIvaFromPadron", () => {
  it("reconoce el formato del emisor (guion bajo, minúsculas)", () => {
    expect(normalizeCondicionIvaFromPadron("responsable_inscripto")).toBe("RI");
    expect(normalizeCondicionIvaFromPadron("monotributo")).toBe("MONOTRIBUTO");
  });

  it("reconoce el formato del padrón (espacios, mayúsculas)", () => {
    expect(normalizeCondicionIvaFromPadron("RESPONSABLE INSCRIPTO")).toBe("RI");
    expect(normalizeCondicionIvaFromPadron("MONOTRIBUTO")).toBe("MONOTRIBUTO");
    expect(normalizeCondicionIvaFromPadron("EXENTO")).toBe("EXENTO");
  });

  it("devuelve NO_CATEGORIZADO para valores vacíos o no reconocidos", () => {
    expect(normalizeCondicionIvaFromPadron(null)).toBe("NO_CATEGORIZADO");
    expect(normalizeCondicionIvaFromPadron(undefined)).toBe("NO_CATEGORIZADO");
    expect(normalizeCondicionIvaFromPadron("algo_desconocido")).toBe("NO_CATEGORIZADO");
  });
});
