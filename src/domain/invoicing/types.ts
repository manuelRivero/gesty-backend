/**
 * DTOs normalizados del dominio de facturación electrónica. Ningún tipo específico de un
 * proveedor debe cruzar esta frontera: el adaptador traduce desde/hacia
 * estos tipos (ver `BillingProvider` en `billingProvider.port.ts`).
 */

export type FiscalVoucherType = "A" | "B" | "C";

export type FiscalInvoiceStatus =
  | "pending"
  | "processing"
  | "authorized"
  | "rejected"
  | "failed"
  | "requires_review"
  | "cancelled"
  /**
   * Comprobante emitido contra un token de entorno de pruebas (`modo_simulacion: true` en
   * Sistemas 360): tiene CAE de prueba y NO tiene validez fiscal real. Nunca debe presentarse al
   * restaurante como "autorizado" — ver `sistemas360Normalizer.ts`.
   */
  | "simulated";

export type CondicionIva =
  | "RI" // Responsable Inscripto
  | "MONOTRIBUTO"
  | "EXENTO"
  | "CF" // Consumidor Final
  | "NO_CATEGORIZADO";

export interface FiscalIssuerConfig {
  cuit: string;
  razonSocial: string;
  condicionIva: CondicionIva;
  domicilioFiscal: string;
  /**
   * Identificador del emisor dentro de la cuenta central de Sistemas 360, o null cuando todavía
   * no se aprovisionó.
   */
  externalIssuerId?: string | null;
}

export interface FiscalInvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  /** Alícuota de IVA aplicada (porcentaje, p. ej. 21). */
  vatRate: number;
}

export interface FiscalCustomer {
  /** DNI/CUIT del receptor. Si no se conoce, se emite a Consumidor Final. */
  documentType: "DNI" | "CUIT" | "CONSUMIDOR_FINAL";
  documentNumber: string | null;
  name: string;
  email: string | null;
  address: string | null;
  /**
   * Condición de IVA del RECEPTOR (distinta de `FiscalIssuerConfig.condicionIva`, que es la del
   * emisor). Algunos proveedores (Sistemas 360) la exigen siempre. Hoy Gesty solo construye
   * clientes `CONSUMIDOR_FINAL` → `CF` (ver `buildCustomer` en `invoice.service.ts`).
   */
  condicionIva: CondicionIva;
}

/** Operación de emisión solicitada al proveedor. `externalReference` es la clave de idempotencia. */
export interface IssueInvoiceRequest {
  externalReference: string;
  voucherType: FiscalVoucherType;
  issuer: FiscalIssuerConfig;
  customer: FiscalCustomer;
  items: FiscalInvoiceLineItem[];
  totalAmount: number;
  currencyCode: string;
}

export interface IssueCreditNoteRequest extends IssueInvoiceRequest {
  /** Comprobante original que se está anulando/ajustando, identificado por su `externalReference`. */
  originalExternalReference: string;
}

/** Resultado normalizado de una operación de emisión, consulta o PDF. */
export interface FiscalInvoiceResult {
  status: FiscalInvoiceStatus;
  providerInvoiceId: string | null;
  voucherType: FiscalVoucherType | null;
  puntoVenta: number | null;
  comprobanteNumero: number | null;
  cae: string | null;
  caeVencimiento: string | null; // ISO date
  pdfUrl: string | null;
  /** Mensaje de rechazo fiscal o error técnico, si corresponde. */
  errorMessage: string | null;
  /** Respuesta normalizada (no la cruda del proveedor) para trazabilidad. */
  raw: Record<string, unknown>;
}

export interface IssuerRegistrationRequest {
  issuer: FiscalIssuerConfig;
}

export interface IssuerStatusResult {
  status: "not_configured" | "pending_validation" | "validated" | "rejected";
  externalIssuerId: string | null;
  detail: string | null;
}

export interface ValidateConfigurationResult {
  valid: boolean;
  errors: string[];
}

/** Capacidades que un proveedor puede no soportar; el dominio nunca debe simular una que falte. */
export type BillingProviderCapability =
  | "registerIssuer"
  | "creditNote"
  | "pdf"
  | "voucherTypeA"
  | "voucherTypeC";

export class UnsupportedCapabilityError extends Error {
  constructor(provider: string, capability: BillingProviderCapability) {
    super(`El proveedor "${provider}" no soporta la capacidad "${capability}".`);
    this.name = "UnsupportedCapabilityError";
  }
}

/** Error técnico (red, timeout, proveedor caído) — nunca implica rechazo fiscal. */
export class BillingProviderTechnicalError extends Error {
  constructor(provider: string, message: string, public readonly cause?: unknown) {
    super(`[${provider}] Error técnico: ${message}`);
    this.name = "BillingProviderTechnicalError";
  }
}

/** Rechazo fiscal explícito del proveedor/AFIP (no es error técnico, no debe reintentarse igual). */
export class BillingProviderRejectionError extends Error {
  constructor(provider: string, message: string, public readonly details: unknown) {
    super(`[${provider}] Rechazo fiscal: ${message}`);
    this.name = "BillingProviderRejectionError";
  }
}
