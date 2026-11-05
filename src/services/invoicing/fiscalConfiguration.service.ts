import { FiscalConfigStatus, type fiscal_configuration } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { isValidCuit } from "./cuitValidator";
import { resolveBillingProvider } from "./billingProviderFactory";
import { withFiscalConfigurationLock } from "./fiscalConfigurationLock";
import type { IssuerStatusResult, ValidateConfigurationResult } from "../../domain/invoicing/types";

export interface UpsertFiscalConfigurationInput {
  cuit: string;
  razonSocial: string;
  condicionIva: string;
  domicilioFiscal: string;
  autoIssueOnline: boolean;
  autoIssueCash: boolean;
}

export class InvalidFiscalConfigurationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Configuración fiscal inválida: ${errors.join(", ")}`);
    this.name = "InvalidFiscalConfigurationError";
  }
}

function normalizeCuit(cuit: string | null | undefined): string {
  return (cuit ?? "").replace(/\D/g, "");
}

export async function getFiscalConfiguration(
  businessId: string
): Promise<fiscal_configuration | null> {
  return prisma.fiscal_configuration.findUnique({ where: { business_id: businessId } });
}

/**
 * Crea o actualiza la configuración fiscal. No valida contra el proveedor (eso es
 * `BillingProvider.validateConfiguration` / `getIssuerStatus`) — esto solo valida forma.
 */
export async function upsertFiscalConfiguration(
  businessId: string,
  input: UpsertFiscalConfigurationInput
): Promise<fiscal_configuration> {
  const errors: string[] = [];
  if (!isValidCuit(input.cuit)) errors.push("El CUIT no es válido.");
  if (!input.razonSocial.trim()) errors.push("La razón social es obligatoria.");
  if (errors.length > 0) {
    throw new InvalidFiscalConfigurationError(errors);
  }

  return withFiscalConfigurationLock(businessId, async () => {
    const current = await getFiscalConfiguration(businessId);
    const cuitChanged =
      current !== null && normalizeCuit(current.cuit) !== normalizeCuit(input.cuit);

    return prisma.fiscal_configuration.upsert({
      where: { business_id: businessId },
      create: {
        business_id: businessId,
        cuit: input.cuit,
        razon_social: input.razonSocial,
        condicion_iva: input.condicionIva,
        domicilio_fiscal: input.domicilioFiscal,
        punto_venta: null,
        auto_issue_online: input.autoIssueOnline,
        auto_issue_cash: input.autoIssueCash,
        status: FiscalConfigStatus.pending_validation,
      },
      update: {
        cuit: input.cuit,
        razon_social: input.razonSocial,
        condicion_iva: input.condicionIva,
        domicilio_fiscal: input.domicilioFiscal,
        auto_issue_online: input.autoIssueOnline,
        auto_issue_cash: input.autoIssueCash,
        ...(cuitChanged
          ? {
              external_issuer_id: null,
              external_issuer_cuit: null,
              external_issuer_environment: null,
              punto_venta: null,
              validated_at: null,
              status: FiscalConfigStatus.pending_validation,
            }
          : {}),
        updated_at: new Date(),
      },
    });
  });
}

/**
 * Verifica la configuración central de Sistemas 360 y consulta el estado del emisor sin alterar
 * `status`: la respuesta del proveedor no sustituye la validación fiscal persistida.
 */
export async function checkFiscalConfigurationConnectivity(
  businessId: string
): Promise<{ credentialsShapeValid: boolean; credentialErrors: string[]; issuerStatus: IssuerStatusResult | null }> {
  const billingProvider = await resolveBillingProvider(businessId);
  if (!billingProvider) {
    return {
      credentialsShapeValid: false,
      credentialErrors: ["No hay una cuenta central activa de Sistemas 360 con token configurado."],
      issuerStatus: null,
    };
  }
  const shape: ValidateConfigurationResult = await billingProvider.validateConfiguration();
  const issuerStatus = await billingProvider.getIssuerStatus();
  return { credentialsShapeValid: shape.valid, credentialErrors: shape.errors, issuerStatus };
}
