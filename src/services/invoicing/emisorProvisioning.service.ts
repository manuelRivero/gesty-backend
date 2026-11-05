import { FiscalConfigStatus, Prisma } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import type { CondicionIva, IssuerStatusResult } from "../../domain/invoicing/types";
import { BillingProviderTechnicalError } from "../../domain/invoicing/types";
import { BillingLockTimeoutError, BillingLockUnavailableError } from "../billing/billingLock";
import { resolveBillingProvider, resolveCurrentEnvironment } from "./billingProviderFactory";
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

function logDebug(businessId: string, message: string, extra?: Record<string, unknown>): void {
  console.debug("[EmisorProvisioning]", message, { businessId, ...extra });
}

function isExternalIssuerUniqueConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }
  const externalIssuerUniqueIndexNames = [
    "unique_fiscal_configuration_external_issuer_id",
    "unique_fiscal_configuration_issuer_environment_id",
    "unique_fiscal_configuration_issuer_id_without_environment",
    "unique_fiscal_configuration_issuer_id_except_production",
    "unique_fiscal_configuration_issuer_id_except_sandbox",
  ];
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  if (typeof target === "string") {
    return (
      target.includes("external_issuer_id") ||
      externalIssuerUniqueIndexNames.some((indexName) => target.includes(indexName))
    );
  }
  return Array.isArray(target) && target.includes("external_issuer_id");
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
    logDebug(businessId, "Iniciando verificación/asociación de emisor");

    const fresh = await getFiscalConfiguration(businessId);
    if (!fresh || !fresh.cuit || !fresh.razon_social) {
      logDebug(businessId, "Faltan datos fiscales, se aborta", {
        hasFiscalConfiguration: Boolean(fresh),
        hasCuit: Boolean(fresh?.cuit),
        hasRazonSocial: Boolean(fresh?.razon_social),
      });
      return { provisioned: false, externalIssuerId: null, status: "not_configured", detail: "Faltan datos fiscales del negocio." };
    }

    const cuit = fresh.cuit;
    const normalizedCuit = normalizeCuit(cuit);
    const environment = await resolveCurrentEnvironment();
    if (!environment) {
      logDebug(businessId, "No se pudo determinar el entorno activo de Sistemas 360");
      return { provisioned: false, externalIssuerId: null, status: "not_configured", detail: "No se pudo determinar el entorno activo de Sistemas 360." };
    }

    if (
      fresh.external_issuer_id &&
      fresh.external_issuer_environment === environment &&
      normalizeCuit(fresh.external_issuer_cuit) === normalizedCuit
    ) {
      logDebug(businessId, "Ya asociado, no se requiere acción", {
        environment,
        externalIssuerId: fresh.external_issuer_id,
      });
      return { provisioned: true, externalIssuerId: fresh.external_issuer_id, status: "pending_validation", detail: "Ya asociado." };
    }

    const provider = await resolveBillingProvider(businessId, { environment });
    if (!provider) {
      logDebug(businessId, "Sin token central activo para el entorno", { environment });
      return { provisioned: false, externalIssuerId: null, status: "not_configured", detail: "No hay token central de Sistemas 360 configurado/activo." };
    }

    logDebug(businessId, "Llamando a registerIssuer en el proveedor", {
      environment,
      normalizedCuit,
      condicionIva: fresh.condicion_iva ?? "NO_CATEGORIZADO",
    });

    let result: Awaited<ReturnType<typeof provider.registerIssuer>>;
    try {
      result = await provider.registerIssuer({
        issuer: {
          cuit,
          razonSocial: fresh.razon_social,
          condicionIva: (fresh.condicion_iva ?? "NO_CATEGORIZADO") as CondicionIva,
          domicilioFiscal: fresh.domicilio_fiscal ?? "",
        },
      });
    } catch (err) {
      // No se swallowea: se deja constancia en este eslabón intermedio y se relanza la misma
      // excepción (con su `cause` original intacta) para que el catch final del controller
      // también pueda verla.
      logDebug(businessId, "registerIssuer lanzó una excepción", {
        environment,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    logDebug(businessId, "Respuesta de registerIssuer", {
      status: result.status,
      externalIssuerId: result.externalIssuerId,
    });

    if (result.externalIssuerId) {
      const ownedByOther = await prisma.fiscal_configuration.findFirst({
        where: {
          external_issuer_id: result.externalIssuerId,
          business_id: { not: businessId },
          OR: [
            { external_issuer_environment: environment },
            { external_issuer_environment: null },
          ],
        },
        select: { id: true },
      });
      if (ownedByOther) {
        logDebug(businessId, "Conflicto: emisor ya asociado a otro negocio", {
          environment,
          externalIssuerId: result.externalIssuerId,
          ownedByFiscalConfigurationId: ownedByOther.id,
        });
        return {
          provisioned: false,
          externalIssuerId: null,
          status: "conflict",
          detail:
            "El emisor encontrado en Sistemas 360 para este CUIT ya está asociado a otro negocio de Gesty. No se asoció ni se creó un emisor nuevo — contactá a soporte para resolverlo manualmente.",
        };
      }

      let saved: { count: number };
      try {
        saved = await prisma.fiscal_configuration.updateMany({
          where: {
            business_id: businessId,
            cuit,
            external_issuer_id: fresh.external_issuer_id,
            external_issuer_cuit: fresh.external_issuer_cuit,
            external_issuer_environment: fresh.external_issuer_environment,
          },
          data: {
            external_issuer_id: result.externalIssuerId,
            external_issuer_cuit: normalizedCuit,
            external_issuer_environment: environment,
            // Misma escritura, sin adquirir el lock una segunda vez (ver `provisionAfterFiscalSave`):
            // la asociación recién persistida es, por definición, la que corresponde al CUIT y
            // entorno que se acaban de resolver arriba.
            status: FiscalConfigStatus.validated,
            validated_at: new Date(),
            updated_at: new Date(),
          },
        });
      } catch (error) {
        if (!isExternalIssuerUniqueConflict(error)) throw error;
        logDebug(businessId, "Conflicto de unicidad al persistir external_issuer_id", {
          environment,
          externalIssuerId: result.externalIssuerId,
        });
        return {
          provisioned: false,
          externalIssuerId: null,
          status: "conflict",
          detail:
            "El emisor de Sistemas 360 se asoció a otro negocio durante la operación. No se asignó a este negocio; contactá a soporte para resolverlo.",
        };
      }
      logDebug(businessId, "Escritura condicional de external_issuer_id", {
        updatedRows: saved.count,
        externalIssuerId: result.externalIssuerId,
      });
      if (saved.count !== 1) {
        const latest = await getFiscalConfiguration(businessId);
        const alreadyAssociated =
          latest?.external_issuer_id === result.externalIssuerId &&
          latest.external_issuer_environment === environment &&
          normalizeCuit(latest.external_issuer_cuit) === normalizeCuit(latest.cuit);
        logDebug(businessId, "La configuración fiscal cambió durante la asociación (carrera detectada)", {
          alreadyAssociated,
        });
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

    logDebug(businessId, "Finalizando verificación/asociación de emisor", {
      provisioned: Boolean(result.externalIssuerId),
      status: result.status,
    });

    return {
      provisioned: Boolean(result.externalIssuerId),
      externalIssuerId: result.externalIssuerId,
      status: result.status,
      detail: result.detail,
    };
  });
}

export type FiscalProvisioningOutcome = "provisioned" | "pending" | "requires_attention";

export interface FiscalProvisioningSummary {
  outcome: FiscalProvisioningOutcome;
  detail: string | null;
}

function toProvisioningOutcome(result: EmisorProvisioningResult): FiscalProvisioningOutcome {
  if (result.provisioned) return "provisioned";
  if (result.status === "conflict") return "requires_attention";
  return "pending";
}

/**
 * Variante de `ensureEmisorProvisioned` para el flujo de guardado (`putFiscalConfigurationHandler`):
 * se invoca DESPUÉS de que `upsertFiscalConfiguration` ya liberó su lock (mismo namespace que
 * `ensureEmisorProvisioned` — ver `fiscalConfigurationLock.ts`); nunca se llama desde dentro del
 * callback que mantiene ese lock, para no anidar dos adquisiciones del mismo advisory lock.
 *
 * Nunca lanza por un fallo del proveedor o del lock: un error técnico de Sistemas 360 (o el lock
 * ocupado por otra operación del mismo negocio) no significa que los datos fiscales no se
 * guardaron — se normaliza a `pending` (recuperable, reintentable sin perder los datos) en vez de
 * convertirse en un 500 para el PUT que ya persistió la configuración con éxito.
 */
export async function provisionAfterFiscalSave(businessId: string): Promise<FiscalProvisioningSummary> {
  try {
    const result = await ensureEmisorProvisioned(businessId);
    return { outcome: toProvisioningOutcome(result), detail: result.detail };
  } catch (err) {
    if (err instanceof BillingProviderTechnicalError) {
      return {
        outcome: "pending",
        detail: "No se pudo completar la asociación con Sistemas 360 todavía. Gesty va a reintentarlo automáticamente.",
      };
    }
    if (err instanceof BillingLockTimeoutError || err instanceof BillingLockUnavailableError) {
      return {
        outcome: "pending",
        detail: "Hay otra operación de facturación en curso para este negocio. Gesty va a reintentarlo automáticamente.",
      };
    }
    throw err;
  }
}
