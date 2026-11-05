import type { BillingProvider } from "../../../domain/invoicing/billingProvider.port";
import type {
  BillingProviderCapability,
  CuitLookupResult,
  FiscalCustomer,
  FiscalInvoiceLineItem,
  FiscalInvoiceResult,
  IssueCreditNoteRequest,
  IssueInvoiceRequest,
  IssuerRegistrationRequest,
  IssuerStatusResult,
  ValidateConfigurationResult,
} from "../../../domain/invoicing/types";
import { BillingProviderTechnicalError, CuitNotFoundError } from "../../../domain/invoicing/types";
import {
  extractEmisorId,
  sanitizeForLog,
  Sistemas360HttpError,
  Sistemas360ResponseShapeError,
  sistemas360BuscarPorReferenciaExterna,
  sistemas360CreateEmisor,
  sistemas360CrearComprobante,
  sistemas360DescargarPdf,
  sistemas360GetComprobante,
  sistemas360GetEstadoFiscal,
  sistemas360ListEmisores,
  sistemas360LookupCuit,
  sistemas360Ping,
  sistemas360Reintentar,
  type Sistemas360Cliente,
  type Sistemas360ComprobanteResponse,
  type Sistemas360Item,
} from "./sistemas360Client";
import {
  condicionIvaToReceptorId,
  normalizeCondicionIvaFromPadron,
  normalizeSistemas360Response,
  voucherTypeToTipoComprobante,
} from "./sistemas360Normalizer";

const UNSUPPORTED: ReadonlySet<BillingProviderCapability> = new Set();

// Serializado a JSON para no depender de la profundidad default de `console.debug`/`console.error`
// (2) — a partir de ahí Node imprime `[Object]` y trunca justo lo que esta instrumentación
// necesita mostrar completo (ver `describeError`/`httpBody`).
function logDebug(message: string, extra?: Record<string, unknown>): void {
  console.debug("[Sistemas360Adapter]", message, JSON.stringify(extra ?? {}, null, 2));
}

function logError(message: string, extra?: Record<string, unknown>): void {
  console.error("[Sistemas360Adapter]", message, JSON.stringify(extra ?? {}, null, 2));
}

/** Vuelca toda la información diagnosticable de una excepción sin asumir su tipo concreto. */
function describeError(err: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    errorName: err instanceof Error ? err.name : typeof err,
    errorMessage: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
  if (err instanceof Sistemas360HttpError) {
    base.httpStatus = err.status;
    base.httpBody = sanitizeForLog(err.body);
    base.cause = err.cause instanceof Error ? { name: err.cause.name, message: err.cause.message } : err.cause;
  }
  return base;
}

function toSistemas360Cliente(customer: FiscalCustomer): Sistemas360Cliente {
  if (customer.documentType === "CONSUMIDOR_FINAL" || !customer.documentNumber) {
    return {
      documento_tipo: "consumidor_final",
      documento_numero: null,
      razon_social: customer.name || "Consumidor Final",
      condicion_iva_receptor_id: condicionIvaToReceptorId(customer.condicionIva),
    };
  }
  return {
    documento_tipo: customer.documentType === "CUIT" ? "cuit" : "dni",
    documento_numero: customer.documentNumber,
    razon_social: customer.name,
    condicion_iva_receptor_id: condicionIvaToReceptorId(customer.condicionIva),
  };
}

function toSistemas360Items(items: FiscalInvoiceLineItem[], voucherType: "A" | "B" | "C"): Sistemas360Item[] {
  return items.map((item) => ({
    descripcion: item.description,
    cantidad: item.quantity,
    precio_unitario: item.unitPrice,
    // Factura C no lleva desglose de IVA por ítem (ver documentación de Sistemas 360).
    ...(voucherType === "C"
      ? {}
      : {
          tipo_impuesto: "gravado" as const,
          iva: item.vatRate,
          precios_incluyen_iva: true,
        }),
  }));
}

function toEmisorId(externalIssuerId: string | null | undefined): number | undefined {
  if (!externalIssuerId) return undefined;
  const parsed = Number(externalIssuerId);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Adaptador para Sistemas 360 (API ARCA multiemisor, token de cuenta). Se construye con el
 * token CENTRAL de la cuenta de Gesty (ver `billingProviderFactory.ts`) y recibe el `emisor_id`
 * de cada negocio por dos vías: `emisorId` del constructor (para `getIssuerStatus`, que no recibe
 * un request con datos del emisor) y `request.issuer.externalIssuerId` (para `issueInvoice`/
 * `issueCreditNote`, ya threaded por `invoice.service.ts`).
 *
 * `businessId` (opcional) se usa SOLO para atribuir consumo técnico por negocio
 * (`sistemas360RequestMetrics.ts`) en los métodos que no sean `issueInvoice`/`issueCreditNote`:
 * esos dos ya se contabilizan a nivel de negocio desde `invoice.service.ts` (ver
 * `recordProviderRequest` en `runIssue`) — pasar `businessId` también aquí duplicaría ese conteo.
 * El total de cuenta (`invoicing_central_provider_config.total_requests_count`) sí se incrementa
 * siempre, para los dos casos, porque es un consumo real nuevo que antes no se medía en absoluto.
 */
export class Sistemas360Adapter implements BillingProvider {
  readonly name = "sistemas360";

  constructor(
    private readonly token: string,
    private readonly emisorId: number | null = null,
    private readonly businessId?: string
  ) {}

  supports(capability: BillingProviderCapability): boolean {
    return !UNSUPPORTED.has(capability);
  }

  async validateConfiguration(): Promise<ValidateConfigurationResult> {
    const errors: string[] = [];
    if (!this.token) errors.push("Falta el token de cuenta de Sistemas 360.");
    return { valid: errors.length === 0, errors };
  }

  /**
   * Alta/reutilización de emisor (FASE: relación restaurante-emisor). Antes de crear, busca por
   * CUIT en `GET /api/emisores` para no duplicar — ver `sistemas360CreateEmisor`/`ListEmisores`.
   * El llamador (`emisorProvisioning.service.ts`) es responsable de la idempotencia a nivel de
   * negocio (lock + persistencia atómica); este método asume que ya se decidió crear.
   */
  async registerIssuer(request: IssuerRegistrationRequest): Promise<IssuerStatusResult> {
    try {
      logDebug("registerIssuer: buscando emisor existente por CUIT", {
        businessId: this.businessId,
        method: "GET",
        endpoint: "/emisores",
      });
      const existentes = await sistemas360ListEmisores(this.token, this.businessId);
      const match = existentes.find((e) => normalizeCuit(e.cuit) === normalizeCuit(request.issuer.cuit));
      if (match) {
        logDebug("registerIssuer: emisor existente encontrado, no se crea uno nuevo", {
          businessId: this.businessId,
          habilitadoProduccion: Boolean(match.habilitado_produccion),
        });
        return {
          status: match.habilitado_produccion ? "validated" : "pending_validation",
          externalIssuerId: String(extractEmisorId(match)),
          detail: match.habilitado_produccion
            ? "Emisor ya habilitado para producción en la cuenta de Sistemas 360."
            : "Emisor existente en la cuenta, todavía no habilitado para producción.",
        };
      }

      logDebug("registerIssuer: sin emisor existente, creando uno nuevo", {
        businessId: this.businessId,
        method: "POST",
        endpoint: "/emisores",
      });
      const created = await sistemas360CreateEmisor(
        this.token,
        {
          cuit: request.issuer.cuit.replace(/\D/g, ""),
          nombre_fantasia: request.issuer.razonSocial,
        },
        this.businessId
      );
      logDebug("registerIssuer: emisor creado correctamente", { businessId: this.businessId });
      return {
        status: "pending_validation",
        externalIssuerId: String(extractEmisorId(created)),
        detail: "Emisor creado en Sistemas 360. Falta habilitación para producción (certificado/WSFE).",
      };
    } catch (err) {
      logError("registerIssuer: la operación falló", {
        businessId: this.businessId,
        ...describeError(err),
      });
      if (err instanceof Sistemas360HttpError) {
        throw new BillingProviderTechnicalError(this.name, providerErrorMessage(err), err);
      }
      if (err instanceof Sistemas360ResponseShapeError) {
        throw new BillingProviderTechnicalError(this.name, err.message, err);
      }
      throw err;
    }
  }

  /**
   * Consulta de solo lectura al padrón (FASE: cierre de integración). Nunca crea ni modifica un
   * emisor — a diferencia de `registerIssuer`, no llama a `sistemas360ListEmisores` ni
   * `sistemas360CreateEmisor`. El llamador (`cuitLookup.service.ts`) decide si usa el resultado
   * para prellenar la configuración fiscal del negocio.
   */
  async lookupCuit(cuit: string): Promise<CuitLookupResult> {
    const normalizedCuit = cuit.replace(/\D/g, "");
    try {
      const found = await sistemas360LookupCuit(this.token, normalizedCuit, this.businessId);
      return {
        cuit: found.cuit ?? normalizedCuit,
        razonSocial: found.razon_social ?? null,
        condicionIva: normalizeCondicionIvaFromPadron(found.condicion_iva),
        condicionIvaRaw: found.condicion_iva ?? null,
        domicilioFiscal: found.domicilio_fiscal ?? null,
      };
    } catch (err) {
      if (err instanceof Sistemas360HttpError) {
        if (err.status === 404) {
          throw new CuitNotFoundError(normalizedCuit);
        }
        throw new BillingProviderTechnicalError(this.name, providerErrorMessage(err), err);
      }
      if (err instanceof Sistemas360ResponseShapeError) {
        throw new BillingProviderTechnicalError(this.name, err.message, err);
      }
      throw err;
    }
  }

  async getIssuerStatus(): Promise<IssuerStatusResult> {
    if (!this.emisorId) {
      return { status: "not_configured", externalIssuerId: null, detail: "Todavía no se asoció un emisor de Sistemas 360 a este negocio." };
    }
    try {
      const estadoFiscal = (await sistemas360GetEstadoFiscal(this.token, this.emisorId, this.businessId)) as {
        data?: { habilitado_produccion?: boolean; pendientes?: Array<{ mensaje: string }> };
      };
      const data = estadoFiscal.data ?? {};
      const pendientes = (data.pendientes ?? []).map((p) => p.mensaje).join("; ");
      return {
        status: data.habilitado_produccion ? "validated" : "pending_validation",
        externalIssuerId: String(this.emisorId),
        detail: data.habilitado_produccion
          ? "Habilitado para producción en Sistemas 360."
          : pendientes || "Pendiente de habilitación para producción en Sistemas 360.",
      };
    } catch (err) {
      if (err instanceof Sistemas360HttpError) {
        throw new BillingProviderTechnicalError(this.name, err.message, err);
      }
      throw err;
    }
  }

  async issueInvoice(request: IssueInvoiceRequest): Promise<FiscalInvoiceResult> {
    return this.crearComprobante(request, false, undefined);
  }

  async issueCreditNote(request: IssueCreditNoteRequest): Promise<FiscalInvoiceResult> {
    return this.crearComprobante(request, true, request.originalExternalReference);
  }

  private async crearComprobante(
    request: IssueInvoiceRequest,
    isCreditNote: boolean,
    referenciaExternaAsociada: string | undefined
  ): Promise<FiscalInvoiceResult> {
    const emisorId = toEmisorId(request.issuer.externalIssuerId) ?? this.emisorId ?? undefined;
    try {
      const response = await sistemas360CrearComprobante(this.token, {
        emisor_id: emisorId,
        tipo_comprobante: voucherTypeToTipoComprobante(request.voucherType, isCreditNote),
        referencia_externa: request.externalReference,
        ...(referenciaExternaAsociada ? { referencia_externa_asociada: referenciaExternaAsociada } : {}),
        cliente: toSistemas360Cliente(request.customer),
        items: toSistemas360Items(request.items, request.voucherType),
        total: request.totalAmount,
        moneda: request.currencyCode === "ARS" ? "PES" : request.currencyCode,
      });
      return normalizeSistemas360Response(response);
    } catch (err) {
      if (err instanceof Sistemas360HttpError) {
        throw new BillingProviderTechnicalError(this.name, err.message, err);
      }
      throw err;
    }
  }

  /**
   * Reconciliación (FASE: conciliación sin webhooks). Siempre busca primero por
   * `referencia_externa` (lectura, segura de repetir). Si el estado remoto es
   * `pendiente_confirmacion` o `error`, escala a `POST /reintentar` — Sistemas 360 documenta que
   * ninguno de los dos casos genera un comprobante nuevo: `error` reintenta la MISMA solicitud
   * original y `pendiente_confirmacion` solo consulta a ARCA. Nunca se llama a
   * `POST /comprobantes` de nuevo desde aquí.
   */
  async getInvoiceStatus(externalReference: string): Promise<FiscalInvoiceResult> {
    try {
      const found = await sistemas360BuscarPorReferenciaExterna(this.token, externalReference, this.businessId);
      if (!found) {
        // Sin rastro en el proveedor: no hay nada que reconciliar todavía (pudo no haber llegado
        // a enviarse). El llamador decide qué hacer con esto a través de `requires_review`.
        return {
          status: "requires_review",
          providerInvoiceId: null,
          voucherType: null,
          puntoVenta: null,
          comprobanteNumero: null,
          cae: null,
          caeVencimiento: null,
          pdfUrl: null,
          errorMessage: "No se encontró el comprobante por referencia externa en Sistemas 360.",
          raw: {},
        };
      }

      if (found.estado === "pendiente_confirmacion" || found.estado === "error") {
        const retried = await sistemas360Reintentar(this.token, found.id, this.businessId);
        return normalizeSistemas360Response(retried);
      }

      return normalizeSistemas360Response({ ok: true, data: found });
    } catch (err) {
      if (err instanceof Sistemas360HttpError) {
        // 409 = "resultado sin confirmar" (documentado) — sigue siendo incierto, no un fallo duro.
        if (err.status === 409) {
          return {
            status: "requires_review",
            providerInvoiceId: null,
            voucherType: null,
            puntoVenta: null,
            comprobanteNumero: null,
            cae: null,
            caeVencimiento: null,
            pdfUrl: null,
            errorMessage: "Resultado todavía sin confirmar en Sistemas 360 (409).",
            raw: (err.body as Record<string, unknown>) ?? {},
          };
        }
        throw new BillingProviderTechnicalError(this.name, err.message, err);
      }
      throw err;
    }
  }

  async getInvoice(externalReference: string): Promise<FiscalInvoiceResult> {
    const found = await sistemas360BuscarPorReferenciaExterna(this.token, externalReference, this.businessId);
    if (!found) throw new BillingProviderTechnicalError(this.name, "Comprobante no encontrado", null);
    const detail = await sistemas360GetComprobante(this.token, found.id, this.businessId);
    return normalizeSistemas360Response(detail as Sistemas360ComprobanteResponse);
  }

  /** Descarga el PDF autenticado y lo devuelve como data URL — no hay URL pública reutilizable. */
  async getInvoicePdf(externalReference: string): Promise<string | null> {
    try {
      const found = await sistemas360BuscarPorReferenciaExterna(this.token, externalReference, this.businessId);
      if (!found) return null;
      const pdf = await sistemas360DescargarPdf(this.token, found.id, "a4", this.businessId);
      return `data:application/pdf;base64,${pdf.toString("base64")}`;
    } catch (err) {
      if (err instanceof Sistemas360HttpError) {
        throw new BillingProviderTechnicalError(this.name, err.message, err);
      }
      throw err;
    }
  }

  async getAvailableVoucherTypes(): Promise<Array<"A" | "B" | "C">> {
    return ["A", "B", "C"];
  }
}

function normalizeCuit(cuit: string): string {
  return cuit.replace(/\D/g, "");
}

export async function sistemas360ValidateToken(token: string): Promise<{ ok: boolean; detail: string }> {
  try {
    await sistemas360Ping(token);
    await sistemas360ListEmisores(token);
    return { ok: true, detail: "Token de cuenta válido; se pudo consultar la lista de emisores." };
  } catch (err) {
    if (err instanceof Sistemas360HttpError) {
      if (err.status === 403) {
        return {
          ok: false,
          detail:
            "El token responde, pero no tiene permisos de cuenta para administrar emisores. " +
            "SUPER_ADMIN debe configurar un token de cuenta de Sistemas 360 para este entorno.",
        };
      }
      const path = err.message.match(/en (\/[^ ]+)/)?.[1] ?? "la API";
      return { ok: false, detail: `Sistemas 360 respondió ${err.status} en ${path}.` };
    }
    if (err instanceof Sistemas360ResponseShapeError) {
      return { ok: false, detail: err.message };
    }
    return { ok: false, detail: "No se pudo contactar a Sistemas 360." };
  }
}

function providerErrorMessage(err: Sistemas360HttpError): string {
  if (err.status === 403) {
    return (
      "El token configurado no tiene permisos de cuenta para administrar emisores. " +
      "SUPER_ADMIN debe configurar un token de cuenta de Sistemas 360 para este entorno."
    );
  }
  if (err.body && typeof err.body === "object") {
    const body = err.body as { mensaje_api?: unknown; error?: { mensaje?: unknown; message?: unknown } };
    if (typeof body.mensaje_api === "string") return body.mensaje_api;
    if (typeof body.error?.mensaje === "string") return body.error.mensaje;
    if (typeof body.error?.message === "string") return body.error.message;
  }
  return err.message;
}
