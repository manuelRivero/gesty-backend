import { FiscalConfigStatus, FiscalInvoiceStatus, type invoicing_central_provider_config } from "@prisma/client";
import { prisma } from "../../lib/prisma";
import { decryptToken, encryptToken } from "../payment/crypto";
import { sistemas360HealthArca } from "./providers/sistemas360Client";
import { sistemas360ValidateToken } from "./providers/sistemas360Adapter";

export type CentralProviderEnvironment = "sandbox" | "production";
export const SISTEMAS360_PROVIDER = "sistemas360" as const;

/** Vista segura: nunca incluye los tokens cifrados ni en texto plano. */
export interface CentralProviderConfigSafeView {
  provider: typeof SISTEMAS360_PROVIDER;
  activeEnvironment: CentralProviderEnvironment;
  isActive: boolean;
  status: FiscalConfigStatus;
  lastValidatedAt: string | null;
  lastValidationDetail: string | null;
  /** Entorno al que corresponde la última validación exitosa — puede no coincidir con `activeEnvironment`. */
  lastValidatedEnvironment: CentralProviderEnvironment | null;
  hasSandboxToken: boolean;
  hasProductionToken: boolean;
  /** Consumo técnico total de la cuenta (todas las llamadas HTTP reales) — ver `sistemas360RequestMetrics.ts`. */
  totalRequestsCount: number;
}

function toSafeView(row: invoicing_central_provider_config): CentralProviderConfigSafeView {
  return {
    provider: SISTEMAS360_PROVIDER,
    activeEnvironment: row.active_environment as CentralProviderEnvironment,
    isActive: row.is_active,
    status: row.status,
    lastValidatedAt: row.last_validated_at?.toISOString() ?? null,
    lastValidationDetail: row.last_validation_detail,
    lastValidatedEnvironment: (row.last_validated_environment as CentralProviderEnvironment | null) ?? null,
    hasSandboxToken: Boolean(row.sandbox_token_encrypted),
    hasProductionToken: Boolean(row.production_token_encrypted),
    totalRequestsCount: row.total_requests_count,
  };
}

export class CentralProviderActivationBlockedError extends Error {
  readonly status = 409;
  constructor(message: string) {
    super(message);
    this.name = "CentralProviderActivationBlockedError";
  }
}

export class CentralProviderEnvironmentChangeBlockedError extends Error {
  readonly status = 409;
  constructor(message: string, public readonly pendingCount: number) {
    super(message);
    this.name = "CentralProviderEnvironmentChangeBlockedError";
  }
}

export async function getCentralProviderConfigSafe(
  provider: typeof SISTEMAS360_PROVIDER
): Promise<CentralProviderConfigSafeView | null> {
  const row = await prisma.invoicing_central_provider_config.findUnique({ where: { provider } });
  return row ? toSafeView(row) : null;
}

/** Solo para uso interno (resolución de credenciales) — nunca exponer el resultado vía API. */
export async function getActiveCentralToken(
  provider: typeof SISTEMAS360_PROVIDER
): Promise<{ token: string; environment: CentralProviderEnvironment } | null> {
  const row = await prisma.invoicing_central_provider_config.findUnique({ where: { provider } });
  if (!row || !row.is_active) return null;
  const environment = row.active_environment as CentralProviderEnvironment;
  const encrypted = environment === "production" ? row.production_token_encrypted : row.sandbox_token_encrypted;
  if (!encrypted) return null;
  return { token: decryptToken(encrypted), environment };
}

/**
 * Token de un entorno ESPECÍFICO, sin importar cuál esté `active_environment` ahora — ver FASE
 * "aislamiento del entorno de emisión". Se usa para reconciliar una `fiscal_invoice` ya existente
 * con el entorno en el que se emitió originalmente, aunque la cuenta central haya cambiado de
 * entorno desde entonces. Sigue exigiendo `is_active` (si el proveedor está completamente
 * desactivado, no hay token válido para ningún entorno — ver `invoice.service.ts`, hallazgo
 * "comprobantes pendientes al desactivar el proveedor", que maneja ese caso por separado).
 */
export async function getCentralTokenForEnvironment(
  provider: typeof SISTEMAS360_PROVIDER,
  environment: CentralProviderEnvironment
): Promise<{ token: string; environment: CentralProviderEnvironment } | null> {
  const row = await prisma.invoicing_central_provider_config.findUnique({ where: { provider } });
  if (!row || !row.is_active) return null;
  const encrypted = environment === "production" ? row.production_token_encrypted : row.sandbox_token_encrypted;
  if (!encrypted) return null;
  return { token: decryptToken(encrypted), environment };
}

export interface SetCentralTokenInput {
  provider: typeof SISTEMAS360_PROVIDER;
  environment: CentralProviderEnvironment;
  token: string;
}

/** Solo SUPER_ADMIN (ver `requireRoles` en la ruta) — el controller no debe eco-ar el token. */
export async function setCentralProviderToken(input: SetCentralTokenInput): Promise<CentralProviderConfigSafeView> {
  const encrypted = encryptToken(input.token);
  const field = input.environment === "production" ? "production_token_encrypted" : "sandbox_token_encrypted";

  const row = await prisma.invoicing_central_provider_config.upsert({
    where: { provider: input.provider },
    create: {
      provider: input.provider,
      [field]: encrypted,
      status: FiscalConfigStatus.pending_validation,
    },
    update: {
      [field]: encrypted,
      status: FiscalConfigStatus.pending_validation,
      updated_at: new Date(),
    },
  });
  return toSafeView(row);
}

/**
 * Cambia el entorno activo. Rechaza el cambio (backend, no solo UI) si existen `fiscal_invoice`
 * de este proveedor todavía `processing`/`requires_review` — ver FASE "aislamiento del entorno
 * de emisión": cambiar el entorno con pendientes en curso puede hacer que la reconciliación
 * consulte la cuenta equivocada (sandbox vs. producción son datasets distintos en Sistemas 360).
 * No modifica nada si se rechaza.
 */
export async function setCentralProviderEnvironment(
  provider: typeof SISTEMAS360_PROVIDER,
  environment: CentralProviderEnvironment
): Promise<CentralProviderConfigSafeView> {
  const pendingCount = await prisma.fiscal_invoice.count({
    where: { provider, status: { in: [FiscalInvoiceStatus.processing, FiscalInvoiceStatus.requires_review] } },
  });
  if (pendingCount > 0) {
    throw new CentralProviderEnvironmentChangeBlockedError(
      `No se puede cambiar de entorno: hay ${pendingCount} comprobante(s) pendiente(s) de reconciliar con "${provider}". Esperá a que se resuelvan o queden para revisión manual antes de cambiar de entorno.`,
      pendingCount
    );
  }

  const row = await prisma.invoicing_central_provider_config.update({
    where: { provider },
    data: { active_environment: environment, updated_at: new Date() },
  });
  return toSafeView(row);
}

/**
 * Activa o desactiva la única cuenta de Sistemas 360.
 *
 * Si `active_environment === "production"`, exige (hallazgo "activación de producción sin
 * validación"): token de producción configurado, `status === validated`, y que la última
 * validación exitosa haya sido justamente del entorno "production" — `setCentralProviderToken`
 * ya resetea `status` a `pending_validation` en cada escritura de token, así que un token
 * modificado después de validarse automáticamente deja de cumplir esta condición. Sandbox no
 * tiene esta exigencia: puede activarse sin validar, para facilitar pruebas controladas.
 */
export async function setCentralProviderActive(
  provider: typeof SISTEMAS360_PROVIDER,
  isActive: boolean
): Promise<CentralProviderConfigSafeView> {
  if (isActive) {
    const current = await prisma.invoicing_central_provider_config.findUnique({ where: { provider } });
    if (!current) {
      throw new CentralProviderActivationBlockedError(`No existe configuración para "${provider}".`);
    }
    if (current.active_environment === "production") {
      if (!current.production_token_encrypted) {
        throw new CentralProviderActivationBlockedError(
          "No se puede activar producción: falta configurar el token de producción."
        );
      }
      if (current.status !== FiscalConfigStatus.validated || current.last_validated_environment !== "production") {
        throw new CentralProviderActivationBlockedError(
          "No se puede activar producción: el token de producción todavía no fue validado exitosamente (o se modificó después de la última validación). Validá la conectividad antes de activar."
        );
      }
    }

  }
  const row = await prisma.invoicing_central_provider_config.update({
    where: { provider },
    data: { is_active: isActive, updated_at: new Date() },
  });
  return toSafeView(row);
}

/**
 * Valida el token del entorno activo contra el proveedor real (`GET /api/ping` para Sistemas
 * 360). No confirma habilitación para producción de ningún emisor en particular — eso es
 * `BillingProvider.getIssuerStatus()` por negocio.
 */
export async function validateCentralProviderConnectivity(
  provider: typeof SISTEMAS360_PROVIDER
): Promise<CentralProviderConfigSafeView> {
  const active = await getActiveCentralToken(provider);
  const arcaHealth = await sistemas360HealthArca();

  if (!active) {
    const row = await prisma.invoicing_central_provider_config.update({
      where: { provider },
      data: {
        status: FiscalConfigStatus.rejected,
        last_validated_at: new Date(),
        last_validation_detail: "No hay token configurado para el entorno activo.",
      },
    });
    return toSafeView(row);
  }

  const result = await sistemas360ValidateToken(active.token);
  const detail = `${result.detail} ARCA/WSFE: ${arcaHealth.ok ? "operativo" : "no disponible"}.`;
  const row = await prisma.invoicing_central_provider_config.update({
    where: { provider },
    data: {
      status: result.ok ? FiscalConfigStatus.validated : FiscalConfigStatus.rejected,
      last_validated_at: new Date(),
      last_validation_detail: detail,
      // Solo se registra qué entorno quedó validado cuando la validación fue exitosa — un
      // intento fallido no debe habilitar `setCentralProviderActive` para ningún entorno.
      last_validated_environment: result.ok ? active.environment : null,
    },
  });
  return toSafeView(row);
}
