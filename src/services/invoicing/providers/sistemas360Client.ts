/**
 * Cliente HTTP mínimo para la API de Sistemas 360 (facturación ARCA multiemisor).
 *
 * Endpoints y campos verificados contra https://api.sistemas360.ar/documentacion-api (nov. 2026):
 * - Auth: header `Authorization: Bearer TOKEN`. El entorno (sandbox/producción) lo determina el
 *   token usado, no un parámetro.
 * - "Token de cuenta" administra varios emisores — hay que enviar `emisor_id` en cada comprobante.
 * - Emisión: POST /api/comprobantes. Idempotencia: `referencia_externa`.
 * - Reintento: POST /api/comprobantes/{id}/reintentar — sin body; para `error` reintenta la
 *   autorización original, para `pendiente_confirmacion` solo consulta a ARCA (nunca reemite).
 * - Consulta: GET /api/comprobantes?referencia_externa=... (listado) y GET /api/comprobantes/{id}.
 * - PDF: GET /api/comprobantes/{id}/imprimir-a4 | /imprimir-ticket, con `Accept: application/pdf`.
 * - Emisores: GET/POST /api/emisores, GET /api/emisores/{id}, GET /api/emisores/{id}/estado-fiscal.
 * - GET /api/ping (valida token/entorno), GET /api/health/arca (público, sin token).
 *
 * NO implementado (fuera de alcance de esta integración, requieren flujo manual de certificados
 * o habilitación de producción por emisor — ver informe de cierre):
 * `PATCH /api/emisores/{id}`, `POST /api/emisores/{id}/actualizar-padron`,
 * `POST /api/emisores/{id}/validar`, `POST /api/emisores/{id}/configuracion-fiscal`,
 * `DELETE /api/emisores/{id}`.
 */

import { recordSistemas360Request } from "./sistemas360RequestMetrics";

const BASE_URL = process.env.SISTEMAS360_BASE_URL ?? "https://api.sistemas360.ar/api";

export class Sistemas360HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "Sistemas360HttpError";
  }
}

export class Sistemas360ResponseShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Sistemas360ResponseShapeError";
  }
}

/**
 * Único punto de transporte HTTP hacia Sistemas 360 (salvo `sistemas360DescargarPdf`, que no
 * puede reusarlo porque pide `Accept: application/pdf`, no JSON — instrumentada igual, por
 * separado). Cada llamada a `fetch` de aquí dentro se contabiliza EXACTAMENTE una vez vía
 * `recordSistemas360Request`, sin importar si termina en éxito, 4xx/5xx o error de transporte —
 * así ningún caller nuevo puede olvidarse de contabilizar.
 */
async function request<T>(
  token: string,
  method: "GET" | "POST",
  path: string,
  options: {
    query?: Record<string, string | number | undefined>;
    body?: unknown;
    businessId?: string;
  } = {}
): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (err) {
    // Se intentó enviar la solicitud (el `fetch` se ejecutó): cuenta igual que un intento HTTP,
    // aunque nunca haya llegado una respuesta.
    await recordSistemas360Request(options.businessId);
    throw new Sistemas360HttpError(`Fallo de red contra Sistemas 360 (${path})`, 0, null, err);
  }

  // Llegó una respuesta (2xx o no): es un request real contra la cuenta, se contabiliza antes de
  // decidir si se lanza un error por `!response.ok`.
  await recordSistemas360Request(options.businessId);

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    // Respuestas sin body (p. ej. 503 de /health/arca) son válidas; no todos los endpoints
    // devuelven JSON.
  }

  if (!response.ok) {
    throw new Sistemas360HttpError(
      `Sistemas 360 respondió ${response.status} en ${path}`,
      response.status,
      parsed
    );
  }

  return parsed as T;
}

export interface Sistemas360Cliente {
  documento_tipo: "cuit" | "cuil" | "dni" | "cdi" | "pasaporte" | "documento_extranjero" | "consumidor_final";
  documento_numero: string | null;
  razon_social?: string;
  condicion_iva_receptor_id: number;
}

export interface Sistemas360Item {
  descripcion: string;
  cantidad: number;
  precio_unitario: number;
  tipo_impuesto?: "gravado" | "exento" | "no_gravado";
  iva?: number;
  precios_incluyen_iva?: boolean;
}

export interface Sistemas360CrearComprobanteRequest {
  emisor_id?: number;
  tipo_comprobante: string;

  referencia_externa?: string;
  cliente: Sistemas360Cliente;
  items: Sistemas360Item[];
  total: number;
  moneda?: string;
  comprobante_asociado_id?: number;
  referencia_externa_asociada?: string;
}

export interface Sistemas360ComprobanteData {
  id: number;
  empresa_id?: number;
  entorno: "pruebas" | "produccion";
  modo_simulacion: boolean;
  estado: "autorizado" | "simulado" | "rechazado" | "error" | "pendiente_confirmacion" | "pendiente";
  fecha_registro?: string;
  fecha_autorizacion?: string | null;
  tipo_comprobante: string;
  punto_venta?: number;
  numero_comprobante?: number | null;
  cae?: string | null;
  cae_vencimiento?: string | null;
  referencia_externa?: string | null;
  mensajes_arca?: Array<{ mensaje?: string; codigo?: string }> | null;
  imprimir_a4_url?: string | null;
  imprimir_ticket_url?: string | null;
  [key: string]: unknown;
}

export interface Sistemas360ComprobanteResponse {
  ok: boolean;
  mensaje?: string | null;
  mensaje_api?: string | null;
  data: Sistemas360ComprobanteData;
  error?: { detalles?: unknown; code?: string };
}

export interface Sistemas360Emisor {
  id: number;
  cuit: string;
  razon_social?: string;
  condicion_iva?: string;
  nombre_fantasia?: string | null;
  habilitado_produccion?: boolean;
  pendientes?: Array<{ codigo: string; mensaje: string }>;
  [key: string]: unknown;
}

export async function sistemas360Ping(token: string, businessId?: string): Promise<unknown> {
  return request(token, "GET", "/ping", { businessId });
}

/**
 * Público, sin token — disponibilidad de WSFE/ARCA, no la cuenta. No se instrumenta: no consume
 * cupo de la cuenta (no lleva `Authorization`, no es un request "contra la cuenta").
 */
export async function sistemas360HealthArca(): Promise<{ ok: boolean; status: number }> {
  try {
    const response = await fetch(`${BASE_URL}/health/arca`);
    return { ok: response.status === 200, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

function unwrapData<T>(result: { data?: T } | T): T {
  if (result && typeof result === "object" && "data" in result && result.data !== undefined) {
    return (result as { data: T }).data;
  }
  return result as T;
}

export async function sistemas360ListEmisores(token: string, businessId?: string): Promise<Sistemas360Emisor[]> {
  const result = await request<unknown>(token, "GET", "/emisores", { businessId });
  if (Array.isArray(result)) return result as Sistemas360Emisor[];
  if (!result || typeof result !== "object") {
    throw new Sistemas360ResponseShapeError("La respuesta de Sistemas 360 en /emisores no contiene una lista.");
  }

  const response = result as {
    data?: unknown;
    emisores?: unknown;
  };
  if (Array.isArray(response.data)) return response.data as Sistemas360Emisor[];
  if (Array.isArray(response.emisores)) return response.emisores as Sistemas360Emisor[];
  if (response.data && typeof response.data === "object") {
    const data = response.data as { emisores?: unknown };
    if (Array.isArray(data.emisores)) return data.emisores as Sistemas360Emisor[];
  }

  throw new Sistemas360ResponseShapeError(
    "Sistemas 360 respondió en /emisores, pero la respuesta no contiene una lista de emisores reconocible."
  );
}

export async function sistemas360CreateEmisor(
  token: string,
  input: { cuit: string; nombre_fantasia?: string; ingresos_brutos?: string; fecha_inicio_actividades?: string },
  businessId?: string
): Promise<Sistemas360Emisor> {
  const result = await request<{ data?: Sistemas360Emisor } | Sistemas360Emisor>(
    token,
    "POST",
    "/emisores",
    { body: input, businessId }
  );
  return unwrapData<Sistemas360Emisor>(result);
}

export async function sistemas360GetEmisor(
  token: string,
  emisorId: number,
  businessId?: string
): Promise<Sistemas360Emisor> {
  const result = await request<{ data?: Sistemas360Emisor } | Sistemas360Emisor>(
    token,
    "GET",
    `/emisores/${emisorId}`,
    { businessId }
  );
  return unwrapData<Sistemas360Emisor>(result);
}

export async function sistemas360GetEstadoFiscal(
  token: string,
  emisorId: number,
  businessId?: string
): Promise<unknown> {
  return request(token, "GET", `/emisores/${emisorId}/estado-fiscal`, { businessId });
}

export async function sistemas360CrearComprobante(
  token: string,
  payload: Sistemas360CrearComprobanteRequest,
  businessId?: string
): Promise<Sistemas360ComprobanteResponse> {
  return request(token, "POST", "/comprobantes", { body: payload, businessId });
}

export async function sistemas360BuscarPorReferenciaExterna(
  token: string,
  referenciaExterna: string,
  businessId?: string
): Promise<Sistemas360ComprobanteData | null> {
  const result = await request<{ data?: Sistemas360ComprobanteData[] } | Sistemas360ComprobanteData[]>(
    token,
    "GET",
    "/comprobantes",
    { query: { referencia_externa: referenciaExterna }, businessId }
  );
  const list = Array.isArray(result) ? result : result.data ?? [];
  return list[0] ?? null;
}

export async function sistemas360GetComprobante(
  token: string,
  id: number,
  businessId?: string
): Promise<Sistemas360ComprobanteResponse> {
  return request(token, "GET", `/comprobantes/${id}`, { businessId });
}

export async function sistemas360Reintentar(
  token: string,
  id: number,
  businessId?: string
): Promise<Sistemas360ComprobanteResponse> {
  return request(token, "POST", `/comprobantes/${id}/reintentar`, { businessId });
}

/**
 * Devuelve el PDF como Buffer; el llamador decide cómo exponerlo (p. ej. data URL). No reusa
 * `request()` (pide `Accept: application/pdf`, no JSON) — instrumentada igual, por separado.
 */
export async function sistemas360DescargarPdf(
  token: string,
  id: number,
  formato: "a4" | "ticket",
  businessId?: string
): Promise<Buffer> {
  const path = formato === "a4" ? `/comprobantes/${id}/imprimir-a4` : `/comprobantes/${id}/imprimir-ticket`;
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/pdf" },
    });
  } catch (err) {
    await recordSistemas360Request(businessId);
    throw new Sistemas360HttpError(`Fallo de red descargando PDF (${path})`, 0, null, err);
  }
  await recordSistemas360Request(businessId);
  if (!response.ok) {
    throw new Sistemas360HttpError(`Sistemas 360 respondió ${response.status} en ${path}`, response.status, null);
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
