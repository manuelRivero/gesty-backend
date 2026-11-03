import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../sistemas360RequestMetrics", () => ({
  recordSistemas360Request: vi.fn().mockResolvedValue(undefined),
}));

import { recordSistemas360Request } from "../sistemas360RequestMetrics";
import {
  sistemas360CrearComprobante,
  sistemas360DescargarPdf,
  sistemas360HealthArca,
  sistemas360ListEmisores,
  sistemas360Reintentar,
  Sistemas360HttpError,
  Sistemas360ResponseShapeError,
} from "../sistemas360Client";

function mocked(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("instrumentación de requests reales contra Sistemas 360 (hallazgo crítico)", () => {
  it.each([
    [{ data: [{ id: 1, cuit: "20123456786" }] }],
    [{ emisores: [{ id: 1, cuit: "20123456786" }] }],
    [{ data: { emisores: [{ id: 1, cuit: "20123456786" }] } }],
  ])("normaliza una lista de emisores de las formas documentadas de respuesta", async (body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, body)));

    await expect(sistemas360ListEmisores("account-token")).resolves.toEqual([
      { id: 1, cuit: "20123456786" },
    ]);
  });

  it("rechaza una respuesta exitosa que no permite determinar la lista de emisores", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, data: { total: 0 } })));

    await expect(sistemas360ListEmisores("account-token")).rejects.toBeInstanceOf(
      Sistemas360ResponseShapeError
    );
    expect(recordSistemas360Request).toHaveBeenCalledTimes(1);
  });

  it("un request exitoso (2xx) se contabiliza exactamente una vez", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, data: { id: 1, estado: "autorizado" } }));
    vi.stubGlobal("fetch", fetchMock);

    await sistemas360CrearComprobante("tok", {
      tipo_comprobante: "factura_b",
      cliente: { documento_tipo: "consumidor_final", documento_numero: null, condicion_iva_receptor_id: 5 },
      items: [],
      total: 100,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordSistemas360Request).toHaveBeenCalledTimes(1);
  });

  it("una respuesta 4xx se contabiliza exactamente una vez (y sigue lanzando el error de negocio)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(422, { error: { code: "datos_invalidos" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sistemas360CrearComprobante("tok", {
        tipo_comprobante: "factura_b",
        cliente: { documento_tipo: "consumidor_final", documento_numero: null, condicion_iva_receptor_id: 5 },
        items: [],
        total: 100,
      })
    ).rejects.toBeInstanceOf(Sistemas360HttpError);

    expect(recordSistemas360Request).toHaveBeenCalledTimes(1);
  });

  it("una respuesta 5xx se contabiliza exactamente una vez", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503, {}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sistemas360Reintentar("tok", 1)).rejects.toBeInstanceOf(Sistemas360HttpError);

    expect(recordSistemas360Request).toHaveBeenCalledTimes(1);
  });

  it("un error de transporte (fetch rechaza) después de intentar la solicitud se contabiliza una vez", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sistemas360Reintentar("tok", 1)).rejects.toBeInstanceOf(Sistemas360HttpError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordSistemas360Request).toHaveBeenCalledTimes(1);
  });

  it("/reintentar contabiliza su propio request real, independiente de la búsqueda previa", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, data: { id: 5, estado: "autorizado" } }));
    vi.stubGlobal("fetch", fetchMock);

    await sistemas360Reintentar("tok", 5, "biz-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordSistemas360Request).toHaveBeenCalledTimes(1);
    expect(recordSistemas360Request).toHaveBeenCalledWith("biz-1");
  });

  it("la descarga de PDF contabiliza su propio request real (no reusa `request()`, pero se instrumenta igual)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sistemas360DescargarPdf("tok", 5, "a4", "biz-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordSistemas360Request).toHaveBeenCalledTimes(1);
    expect(recordSistemas360Request).toHaveBeenCalledWith("biz-1");
  });

  it("un error de transporte en la descarga de PDF también se contabiliza una vez", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sistemas360DescargarPdf("tok", 5, "a4")).rejects.toBeInstanceOf(Sistemas360HttpError);

    expect(recordSistemas360Request).toHaveBeenCalledTimes(1);
  });

  it("sistemas360HealthArca (público, sin token) NO se instrumenta: no consume cupo de cuenta", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sistemas360HealthArca();

    expect(recordSistemas360Request).not.toHaveBeenCalled();
  });
});
