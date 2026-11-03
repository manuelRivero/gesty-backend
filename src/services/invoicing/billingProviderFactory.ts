import type { BillingProvider } from "../../domain/invoicing/billingProvider.port";
import { prisma } from "../../lib/prisma";
import {
  getActiveCentralToken,
  getCentralTokenForEnvironment,
  type CentralProviderEnvironment,
} from "./centralProviderConfig.service";
import { Sistemas360Adapter } from "./providers/sistemas360Adapter";

export interface ResolveBillingProviderOptions {
  environment?: CentralProviderEnvironment;
}

/**
 * Resuelve el único proveedor fiscal de Gesty. Sin configuración central activa y token para
 * el entorno seleccionado devuelve null; nunca intenta otra integración.
 */
export async function resolveBillingProvider(
  businessId: string,
  options?: ResolveBillingProviderOptions
): Promise<BillingProvider | null> {
  const central = options?.environment
    ? await getCentralTokenForEnvironment("sistemas360", options.environment)
    : await getActiveCentralToken("sistemas360");
  if (!central) return null;
  const fiscalConfig = await prisma.fiscal_configuration.findUnique({
    where: { business_id: businessId },
    select: { external_issuer_id: true },
  });
  const emisorId = fiscalConfig?.external_issuer_id ? Number(fiscalConfig.external_issuer_id) : null;
  return new Sistemas360Adapter(central.token, Number.isFinite(emisorId) ? emisorId : null, businessId);
}

/**
 * Entorno (`"sandbox"`/`"production"`) con el que se resolvería HOY una emisión nueva para este
 * proveedor — ver FASE "aislamiento del entorno de emisión". Se captura una sola vez al crear
 * una `fiscal_invoice` (`invoice.service.ts`, `provider_environment`) para que la reconciliación
 * posterior no dependa de qué entorno esté activo en ese momento.
 */
export async function resolveCurrentEnvironment(): Promise<string | null> {
  const central = await getActiveCentralToken("sistemas360");
  return central?.environment ?? null;
}
