import { prisma } from "../../lib/prisma";
import type { CondicionIva, IssuerStatusResult } from "../../domain/invoicing/types";
import { resolveBillingProvider } from "./billingProviderFactory";
import { getFiscalConfiguration } from "./fiscalConfiguration.service";
import { withFiscalConfigurationLock } from "./fiscalConfigurationLock";

export interface EmisorProvisioningResult {
  provisioned: boolean;
  externalIssuerId: string | null;
  status: IssuerStatusResult["status"] | "not_configured" | "conflict";
  detail: string | null;
}

function normalizeCuit(cuit: string | null | undefined): string {
  return (cuit ?? "").replace(/\D/g, "");
}

/**
 * Asocia `business_id` ↔ `emisor_id` de Sistemas 360 (ver auditoría "Credenciales
 * centralizadas", sección 2). Idempotente ante reintentos concurrentes:
 *  1. Cambio de CUIT, aprovisionamiento y envío de comprobantes usan el mismo lock por negocio.
 *  2. Dentro del lock, relee `fiscal_configuration` antes de resolver la asociación.
 *  3. Persiste el ID y el CUIT normalizado con una escritura condicional sobre la configuración
 *     leída; una respuesta obtenida para una configuración anterior no puede sobrescribirla.
 *  4. `registerIssuer` en el adaptador ya busca por CUIT antes de crear (ver
 *     `Sistemas360Adapter.registerIssuer`) — doble protección contra emisores duplicados.
 *  5. Antes de persistir el `external_issuer_id` que devolvió el proveedor, verifica localmente
 *     (en la propia base de Gesty) que ningún OTRO `business_id` ya lo tenga asignado (hallazgo
 *     "reutilización de emisores entre negocios"). El dedup por CUIT del paso 4 es una garantía
 *     del PROVEEDOR ("no me deja crear el mismo CUIT dos veces"), no una garantía de Gesty de que
 *     ese emisor le pertenece a este negocio en particular — dos `business_id` con el mismo CUIT
 *     (error de tipeo, o dos locales que de verdad comparten CUIT) podrían, sin este chequeo,
 *     terminar compartiendo el mismo emisor y arriesgando colisión de numeración si además
 *     comparten punto de venta. Ante esa ambigüedad se detiene el aprovisionamiento
 *     (`status: "conflict"`) y NO se crea ningún emisor remoto nuevo para resolverlo solo.
 */
export async function ensureEmisorProvisioned(businessId: string): Promise<EmisorProvisioningResult> {
  return withFiscalConfigurationLock(businessId, async () => {
    const fresh = await getFiscalConfiguration(businessId);
    if (!fresh || !fresh.cuit || !fresh.razon_social) {
      return { provisioned: false, externalIssuerId: null, status: "not_configured", detail: "Faltan datos fiscales del negocio." };
    }

    const cuit = fresh.cuit;
    const normalizedCuit = normalizeCuit(cuit);
    if (
      fresh.external_issuer_id &&
      normalizeCuit(fresh.external_issuer_cuit) === normalizedCuit
    ) {
      return { provisioned: true, externalIssuerId: fresh.external_issuer_id, status: "pending_validation", detail: "Ya asociado." };
    }

    const provider = await resolveBillingProvider(businessId);
    if (!provider) {
      return { provisioned: false, externalIssuerId: null, status: "not_configured", detail: "No hay token central de Sistemas 360 configurado/activo." };
    }

    const result = await provider.registerIssuer({
      issuer: {
        cuit,
        razonSocial: fresh.razon_social,
        condicionIva: (fresh.condicion_iva ?? "NO_CATEGORIZADO") as CondicionIva,
        domicilioFiscal: fresh.domicilio_fiscal ?? "",
      },
    });

    if (result.externalIssuerId) {
      const ownedByOther = await prisma.fiscal_configuration.findFirst({
        where: { external_issuer_id: result.externalIssuerId, business_id: { not: businessId } },
        select: { id: true },
      });
      if (ownedByOther) {
        return {
          provisioned: false,
          externalIssuerId: null,
          status: "conflict",
          detail:
            "El emisor encontrado en Sistemas 360 para este CUIT ya está asociado a otro negocio de Gesty. No se asoció ni se creó un emisor nuevo — contactá a soporte para resolverlo manualmente.",
        };
      }

      const saved = await prisma.fiscal_configuration.updateMany({
        where: {
          business_id: businessId,
          cuit,
          external_issuer_id: fresh.external_issuer_id,
          external_issuer_cuit: fresh.external_issuer_cuit,
        },
        data: {
          external_issuer_id: result.externalIssuerId,
          external_issuer_cuit: normalizedCuit,
          updated_at: new Date(),
        },
      });
      if (saved.count !== 1) {
        const latest = await getFiscalConfiguration(businessId);
        const alreadyAssociated =
          latest?.external_issuer_id === result.externalIssuerId &&
          normalizeCuit(latest.external_issuer_cuit) === normalizeCuit(latest.cuit);
        return {
          provisioned: alreadyAssociated,
          externalIssuerId: alreadyAssociated ? latest.external_issuer_id : null,
          status: alreadyAssociated ? result.status : "not_configured",
          detail: alreadyAssociated
            ? "Ya asociado."
            : "La configuración fiscal cambió durante la asociación. Reintentá la operación.",
        };
      }
    }

    return {
      provisioned: Boolean(result.externalIssuerId),
      externalIssuerId: result.externalIssuerId,
      status: result.status,
      detail: result.detail,
    };
  });
}
