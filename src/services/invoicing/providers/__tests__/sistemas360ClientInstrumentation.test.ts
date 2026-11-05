import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("../sistemas360RequestMetrics", () => ({
  recordSistemas360Request: vi.fn().mockResolvedValue(undefined),
}));

import { recordSistemas360Request } from "../sistemas360RequestMetrics";
import {
  extractEmisorId,
  sistemas360CrearComprobante,
  sistemas360DescargarPdf,
  sistemas360HealthArca,
  sistemas360ListEmisores,
  sistemas360LookupCuit,
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
  /**
   * Contrato real confirmado contra sandbox (ver diagnóstico "Contrato real GET /emisores",
   * nov. 2026): `{ ok, data: { items: Emisor[], paginacion }, mensaje_api }`. Las formas
   * anteriores (`data: []`, `emisores: []`, `data.emisores: []`) eran una suposición nunca
   * verificada — se reemplazan por el shape real, no se mantienen como fallback especulativo.
   */
  it("normaliza la lista de emisores desde `data.items` (contrato real confirmado en sandbox)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          ok: true,
          data: {
            items: [{ id: 1, cuit: "20123456786" }],
            paginacion: { pagina_actual: 1, por_pagina: 20, total: 1, ultima_pagina: 1 },
          },
          mensaje_api: null,
        })
      )
    );

    await expect(sistemas360ListEmisores("account-token")).resolves.toEqual([
      { id: 1, cuit: "20123456786" },
    ]);
  });

  it("una cuenta sin emisores devuelve `data.items` vacío, no un error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, {
          ok: true,
          data: {
            items: [],
            paginacion: { pagina_actual: 1, por_pagina: 20, total: 0, ultima_pagina: 1 },
          },
          mensaje_api: null,
        })
      )
    );

    await expect(sistemas360ListEmisores("account-token")).resolves.toEqual([]);
  });

  it("rechaza una respuesta exitosa cuyo `data` no tiene `items`", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, data: { total: 0 } })));

    await expect(sistemas360ListEmisores("account-token")).rejects.toBeInstanceOf(
      Sistemas360ResponseShapeError
    );
    expect(recordSistemas360Request).toHaveBeenCalledTimes(1);
  });

  it("rechaza una respuesta exitosa cuyo `data.items` no es un array", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, data: { items: "no-es-un-array" } }))
    );

    await expect(sistemas360ListEmisores("account-token")).rejects.toBeInstanceOf(
      Sistemas360ResponseShapeError
    );
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

  it("sistemas360LookupCuit llama a GET /api/cuit/{cuit} y contabiliza su propio request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: { cuit: "20123456786", razon_social: "Restaurante Test", condicion_iva: "Responsable Inscripto", domicilio_fiscal: "Calle Falsa 123" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sistemas360LookupCuit("tok", "20123456786", "biz-1");

    expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ href: expect.stringContaining("/cuit/20123456786") }),
      expect.anything()
    );
    expect(result).toEqual({
      cuit: "20123456786",
      razon_social: "Restaurante Test",
      condicion_iva: "Responsable Inscripto",
      domicilio_fiscal: "Calle Falsa 123",
    });
    expect(recordSistemas360Request).toHaveBeenCalledTimes(1);
    expect(recordSistemas360Request).toHaveBeenCalledWith("biz-1");
  });

  it("sistemas360LookupCuit propaga un 404 del proveedor como Sistemas360HttpError (CUIT no encontrado)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(404, { mensaje_api: "No encontrado" })));

    const err = await sistemas360LookupCuit("tok", "20123456786").catch((e) => e);
    expect(err).toBeInstanceOf(Sistemas360HttpError);
    expect((err as Sistemas360HttpError).status).toBe(404);
  });
});

describe("extractEmisorId (contrato oficial: data.emisor_id, con `id` tolerado como alias)", () => {
  it("prefiere emisor_id cuando está presente", () => {
    expect(extractEmisorId({ emisor_id: 123, id: 999, cuit: "20123456786" })).toBe(123);
  });

  it("usa id como alias cuando no hay emisor_id", () => {
    expect(extractEmisorId({ id: 88, cuit: "20123456786" })).toBe(88);
  });

  it("rechaza una respuesta sin ningún identificador numérico válido (nunca persistir undefined)", () => {
    expect(() => extractEmisorId({ cuit: "20123456786" })).toThrow(Sistemas360ResponseShapeError);
    expect(() => extractEmisorId({ cuit: "20123456786", id: Number("not-a-number") })).toThrow(
      Sistemas360ResponseShapeError
    );
  });
});
