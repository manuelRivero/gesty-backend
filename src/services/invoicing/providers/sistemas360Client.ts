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
 *   GET /api/emisores confirmado contra sandbox (nov. 2026): `{ ok, data: { items: Emisor[],
 *   paginacion: {...} }, mensaje_api }` — la lista está en `data.items`, no en `data` ni en
 *   `data.emisores`. Ver `sistemas360ListEmisores`.
 * - Padrón: GET /api/cuit/{cuit} — consulta de solo lectura (no registra emisor ni consume plaza
 *   del plan), funciona con el token de cuenta también en sandbox.
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

/** Nunca registrar el valor de estas claves (token/headers de auth), ni siquiera si el proveedor las refleja en el body. */
const SENSITIVE_KEYS = /token|authorization|secret|password/i;

export function sanitizeForLog(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeForLog(item, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEYS.test(key) ? "[omitido]" : sanitizeForLog(val, depth + 1);
  }
  return result;
}

// `console.debug`/`console.error` inspeccionan el objeto con la profundidad default de Node
// (2): a partir de ahí todo se imprime como `[Object]`, lo que trunca justamente las formas
// anidadas que esta instrumentación necesita mostrar completas. Se serializa a JSON en texto
// para no depender de esa profundidad.
function logDebug(message: string, extra?: Record<string, unknown>): void {
  console.debug("[Sistemas360Client]", message, JSON.stringify(extra ?? {}, null, 2));
}

function logError(message: string, extra?: Record<string, unknown>): void {
  console.error("[Sistemas360Client]", message, JSON.stringify(extra ?? {}, null, 2));
}

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

  logDebug("Enviando petición", { method, path, businessId: options.businessId });

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
    const errorName = err instanceof Error ? err.name : typeof err;
    const errorMessage = err instanceof Error ? err.message : String(err);
    logError("Fallo de red antes de recibir respuesta", {
      method,
      path,
      businessId: options.businessId,
      errorName,
      errorMessage,
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw new Sistemas360HttpError(`Fallo de red contra Sistemas 360 (${path})`, 0, null, err);
  }

  // Llegó una respuesta (2xx o no): es un request real contra la cuenta, se contabiliza antes de
  // decidir si se lanza un error por `!response.ok`.
  await recordSistemas360Request(options.businessId);

  logDebug("Respuesta recibida", { method, path, status: response.status, businessId: options.businessId });

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch (parseErr) {
    // Respuestas sin body (p. ej. 503 de /health/arca) son válidas; no todos los endpoints
    // devuelven JSON. Se deja constancia a nivel debug porque, combinado con un `!response.ok`,
    // puede ser la causa real de que no haya `body` para diagnosticar el error.
    logDebug("La respuesta no tiene un cuerpo JSON parseable", {
      method,
      path,
      status: response.status,
      errorMessage: parseErr instanceof Error ? parseErr.message : String(parseErr),
    });
  }

  if (!response.ok) {
    logError("Sistemas 360 respondió con un status de error", {
      method,
      path,
      status: response.status,
      body: sanitizeForLog(parsed),
      businessId: options.businessId,
    });
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
  /**
   * El proveedor confirmó oficialmente (ver auditoría de cierre) que `POST /api/emisores` y
   * `GET /api/emisores` devuelven el identificador en `data.emisor_id`. Se mantiene `id` como
   * alias tolerado por si algún endpoint lo devuelve con ese nombre — no verificado aún contra
   * sandbox real. Usar siempre `extractEmisorId()`, nunca leer `id`/`emisor_id` directamente.
   */
  emisor_id?: number;
  id?: number;
  cuit: string;
  razon_social?: string;
  condicion_iva?: string;
  nombre_fantasia?: string | null;
  habilitado_produccion?: boolean;
  pendientes?: Array<{ codigo: string; mensaje: string }>;
  [key: string]: unknown;
}

/**
 * Único punto de extracción del identificador de emisor desde una respuesta de Sistemas 360.
 * Prefiere `emisor_id` (contrato oficial confirmado) y tolera `id` (asunción previa, no
 * verificada). Rechaza explícitamente cualquier valor no numérico o no finito: nunca debe
 * persistirse `"undefined"`/`"null"` como `external_issuer_id`.
 */
export function extractEmisorId(emisor: Sistemas360Emisor): number {
  const candidate = emisor.emisor_id ?? emisor.id;
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    logError("No se pudo extraer un emisor_id numérico de la respuesta", {
      emisor: sanitizeForLog(emisor),
    });
    throw new Sistemas360ResponseShapeError(
      "La respuesta de Sistemas 360 para el emisor no contiene un identificador numérico válido " +
        "(ni `emisor_id` ni `id`)."
    );
  }
  return candidate;
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

/**
 * Contrato real confirmado contra sandbox (ver diagnóstico "Contrato real GET /emisores",
 * nov. 2026): a diferencia de lo documentado al tope del archivo (que no fijaba un shape
 * concreto para `/emisores`), la respuesta es un listado paginado — la lista de emisores está en
 * `data.items`, no en `data` directamente ni en `data.emisores`. `data.paginacion` no se usa hoy
 * (esta integración no pagina `/emisores`; con cuentas de más de una página habría que
 * recorrerla, fuera de alcance de este cierre).
 */
export async function sistemas360ListEmisores(token: string, businessId?: string): Promise<Sistemas360Emisor[]> {
  const result = await request<unknown>(token, "GET", "/emisores", { businessId });

  if (!result || typeof result !== "object") {
    logError("/emisores: la respuesta no es un objeto reconocible", { result });
    throw new Sistemas360ResponseShapeError("La respuesta de Sistemas 360 en /emisores no contiene una lista.");
  }

  const envelope = result as { data?: unknown };
  const data = envelope.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    logError("/emisores: `data` no tiene la forma esperada ({ items, paginacion })", {
      data: sanitizeForLog(data),
    });
    throw new Sistemas360ResponseShapeError(
      "Sistemas 360 respondió en /emisores, pero `data` no tiene la forma esperada ({ items, paginacion })."
    );
  }

  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    logError("/emisores: `data.items` no es una lista de emisores", { data: sanitizeForLog(data) });
    throw new Sistemas360ResponseShapeError(
      "Sistemas 360 respondió en /emisores, pero `data.items` no es una lista de emisores."
    );
  }

  return items as Sistemas360Emisor[];
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

export interface Sistemas360CuitLookup {
  cuit: string;
  razon_social?: string;
  condicion_iva?: string;
  domicilio_fiscal?: string;
  tipo_persona?: string;
  [key: string]: unknown;
}

/**
 * Consulta de solo lectura al padrón (confirmado por el proveedor: no registra emisor ni
 * consume plaza del plan, funciona con el token de cuenta también en sandbox). El shape exacto
 * de la respuesta no se verificó contra sandbox real (sin credenciales disponibles en esta
 * entrega) — se asume el mismo sobre de `data` que el resto de la API, documentado arriba.
 */
export async function sistemas360LookupCuit(
  token: string,
  cuit: string,
  businessId?: string
): Promise<Sistemas360CuitLookup> {
  const result = await request<{ data?: Sistemas360CuitLookup } | Sistemas360CuitLookup>(
    token,
    "GET",
    `/cuit/${cuit}`,
    { businessId }
  );
  return unwrapData<Sistemas360CuitLookup>(result);
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
