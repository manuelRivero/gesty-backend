import type { CuitLookupResult } from "../../domain/invoicing/types";
import { resolveBillingProvider } from "./billingProviderFactory";
import { isValidCuit } from "./cuitValidator";

export class InvalidCuitError extends Error {
  constructor() {
    super("El CUIT no es válido.");
    this.name = "InvalidCuitError";
  }
}

export class NoCentralProviderError extends Error {
  constructor() {
    super("No hay una cuenta central activa de Sistemas 360 con token configurado.");
    this.name = "NoCentralProviderError";
  }
}

/**
 * Consulta de solo lectura al padrón (`GET /api/cuit/{cuit}`, confirmado por el proveedor: no
 * registra emisor ni consume plaza del plan). No persiste nada — el llamador (frontend) decide
 * si usa el resultado para prellenar `fiscal_configuration` vía `upsertFiscalConfiguration`, que
 * sigue siendo el único punto de escritura de esos datos.
 */
export async function lookupCuit(businessId: string, cuit: string): Promise<CuitLookupResult> {
  if (!isValidCuit(cuit)) throw new InvalidCuitError();

  const provider = await resolveBillingProvider(businessId);
  if (!provider) throw new NoCentralProviderError();

  return provider.lookupCuit(cuit);
}
