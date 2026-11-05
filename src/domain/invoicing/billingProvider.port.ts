import type {
  BillingProviderCapability,
  CuitLookupResult,
  FiscalInvoiceResult,
  IssueCreditNoteRequest,
  IssueInvoiceRequest,
  IssuerRegistrationRequest,
  IssuerStatusResult,
  ValidateConfigurationResult,
} from "./types";

/**
 * Contrato entre el flujo de facturación y el adaptador de Sistemas 360. Mantiene aisladas las
 * llamadas HTTP del proveedor y permite probar el servicio fiscal con implementaciones simuladas.
 */
export interface BillingProvider {
  readonly name: string;

  supports(capability: BillingProviderCapability): boolean;

  validateConfiguration(): Promise<ValidateConfigurationResult>;

  registerIssuer(request: IssuerRegistrationRequest): Promise<IssuerStatusResult>;

  /**
   * Consulta de solo lectura al padrón por CUIT. Nunca debe registrar ni modificar un emisor —
   * eso sigue siendo responsabilidad exclusiva de `registerIssuer`.
   */
  lookupCuit(cuit: string): Promise<CuitLookupResult>;

  getIssuerStatus(): Promise<IssuerStatusResult>;

  issueInvoice(request: IssueInvoiceRequest): Promise<FiscalInvoiceResult>;

  issueCreditNote(request: IssueCreditNoteRequest): Promise<FiscalInvoiceResult>;

  /** Recupera el resultado de una operación ya enviada, por su `externalReference` (idempotencia). */
  getInvoiceStatus(externalReference: string): Promise<FiscalInvoiceResult>;

  getInvoice(externalReference: string): Promise<FiscalInvoiceResult>;

  getInvoicePdf(externalReference: string): Promise<string | null>;

  getAvailableVoucherTypes(): Promise<Array<"A" | "B" | "C">>;
}
