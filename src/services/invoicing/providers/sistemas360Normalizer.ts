import type {
  CondicionIva,
  FiscalInvoiceResult,
  FiscalVoucherType,
} from "../../../domain/invoicing/types";
import type { Sistemas360ComprobanteData, Sistemas360ComprobanteResponse } from "./sistemas360Client";

/** `condicion_iva_receptor_id` documentado por Sistemas 360. Solo se mapean los valores que
 * `CondicionIva` puede representar hoy — el resto (proveedor/cliente del exterior, Ley 19.640,
 * etc.) queda fuera de alcance porque Gesty no los produce en ningún flujo actual. */
const CONDICION_IVA_RECEPTOR_ID: Record<CondicionIva, number> = {
  RI: 1,
  MONOTRIBUTO: 6,
  EXENTO: 4,
  CF: 5,
  NO_CATEGORIZADO: 7,
};

export function condicionIvaToReceptorId(condicionIva: CondicionIva): number {
  return CONDICION_IVA_RECEPTOR_ID[condicionIva];
}

/**
 * Mapeo tolerante de la condición de IVA tal como la devuelve el padrón (`GET /api/cuit/{cuit}`)
 * a `CondicionIva`. El shape exacto de ese campo no se verificó contra sandbox real (ver
 * auditoría de cierre) — por eso es best-effort por substring y SIEMPRE se acompaña del valor
 * crudo del proveedor (`CuitLookupResult.condicionIvaRaw`) para que el llamador no pierda
 * información si el mapeo no reconoce el valor.
 */
export function normalizeCondicionIvaFromPadron(raw: string | null | undefined): CondicionIva {
  if (!raw) return "NO_CATEGORIZADO";
  const normalized = raw
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  if (normalized.includes("MONOTRIBUT")) return "MONOTRIBUTO";
  if (normalized.includes("EXENT")) return "EXENTO";
  if (normalized.includes("CONSUMIDOR FINAL") || normalized === "CF") return "CF";
  if (normalized.includes("RESPONSABLE INSCRIPTO") || normalized === "RI") return "RI";
  return "NO_CATEGORIZADO";
}

const TIPO_COMPROBANTE_BY_VOUCHER: Record<FiscalVoucherType, string> = {
  A: "factura_a",
  B: "factura_b",
  C: "factura_c",
};

const NOTA_CREDITO_BY_VOUCHER: Record<FiscalVoucherType, string> = {
  A: "nota_credito_a",
  B: "nota_credito_b",
  C: "nota_credito_c",
};

export function voucherTypeToTipoComprobante(voucherType: FiscalVoucherType, isCreditNote: boolean): string {
  return isCreditNote ? NOTA_CREDITO_BY_VOUCHER[voucherType] : TIPO_COMPROBANTE_BY_VOUCHER[voucherType];
}

const VOUCHER_TYPE_BY_TIPO_COMPROBANTE: Record<string, FiscalVoucherType> = {
  factura_a: "A",
  factura_b: "B",
  factura_c: "C",
  nota_credito_a: "A",
  nota_credito_b: "B",
  nota_credito_c: "C",
  nota_debito_a: "A",
  nota_debito_b: "B",
  nota_debito_c: "C",
};

/**
 * `estado` → `FiscalInvoiceStatus`. Decisiones no triviales, documentadas explícitamente porque
 * no son una traducción 1:1 obvia:
 * - `error` → `requires_review` (no `failed`): Sistemas 360 documenta que este estado SÍ admite
 *   `POST /reintentar` ("reintenta la autorización con la solicitud original") — no es un fallo
 *   local antes de contactar al proveedor, es un estado recuperable del lado del proveedor.
 * - `pendiente`/`pendiente_confirmacion` → `processing`: ninguno de los dos es terminal; la
 *   reconciliación (`getInvoiceStatus`) debe escalar a `/reintentar` para `pendiente_confirmacion`
 *   específicamente (ver `sistemas360Adapter.ts`).
 * - `simulado` → `simulated` (nunca `authorized`): tiene CAE de prueba, sin validez fiscal real.
 */
function mapEstado(estado: Sistemas360ComprobanteData["estado"]): FiscalInvoiceResult["status"] {
  switch (estado) {
    case "autorizado":
      return "authorized";
    case "simulado":
      return "simulated";
    case "rechazado":
      return "rejected";
    case "error":
      return "requires_review";
    case "pendiente_confirmacion":
    case "pendiente":
      return "processing";
    default:
      return "requires_review";
  }
}

function extractErrorMessage(response: Sistemas360ComprobanteResponse): string | null {
  const data = response.data;
  if (data.estado !== "rechazado" && data.estado !== "error") return null;
  const arcaMessages = (data.mensajes_arca ?? [])
    .map((m) => m.mensaje)
    .filter((m): m is string => Boolean(m));
  if (arcaMessages.length > 0) return arcaMessages.join("; ");
  return response.mensaje ?? response.mensaje_api ?? null;
}

export function normalizeSistemas360Response(
  response: Sistemas360ComprobanteResponse
): FiscalInvoiceResult {
  const data = response.data;
  return {
    status: mapEstado(data.estado),
    providerInvoiceId: String(data.id),
    voucherType: VOUCHER_TYPE_BY_TIPO_COMPROBANTE[data.tipo_comprobante] ?? null,
    puntoVenta: data.punto_venta ?? null,
    comprobanteNumero: data.numero_comprobante ?? null,
    cae: data.cae ?? null,
    caeVencimiento: data.cae_vencimiento ?? null,
    // No se persiste como URL pública: requiere el Bearer de la cuenta para descargarse. El PDF
    // se obtiene a demanda vía `BillingProvider.getInvoicePdf` — ver `sistemas360Adapter.ts`.
    pdfUrl: null,
    errorMessage: extractErrorMessage(response),
    raw: data as Record<string, unknown>,
  };
}
