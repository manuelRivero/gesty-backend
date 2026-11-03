import type { Request, Response } from "express";
import {
  CentralProviderActivationBlockedError,
  CentralProviderEnvironmentChangeBlockedError,
  getCentralProviderConfigSafe,
  setCentralProviderActive,
  setCentralProviderEnvironment,
  setCentralProviderToken,
  SISTEMAS360_PROVIDER,
  validateCentralProviderConnectivity,
  type CentralProviderEnvironment,
} from "../services/invoicing/centralProviderConfig.service";
import { sistemas360HealthArca } from "../services/invoicing/providers/sistemas360Client";

/**
 * Administración de la cuenta CENTRAL de Sistemas 360.
 * Exclusivo de SUPER_ADMIN (ver `requireRoles("SUPER_ADMIN")` en `superAdmin.routes.ts`).
 * Ningún handler de este archivo debe devolver un token, cifrado o no — solo `hasSandboxToken`/
 * `hasProductionToken` (booleanos).
 */

function isValidEnvironment(value: unknown): value is CentralProviderEnvironment {
  return value === "sandbox" || value === "production";
}

function getProviderOrRespond(req: Request, res: Response): typeof SISTEMAS360_PROVIDER | null {
  if (req.params.provider !== SISTEMAS360_PROVIDER) {
    res.status(404).json({ error: "Proveedor de facturación no encontrado." });
    return null;
  }
  return SISTEMAS360_PROVIDER;
}

export async function getCentralProviderConfigHandler(req: Request, res: Response): Promise<void> {
  const provider = getProviderOrRespond(req, res);
  if (!provider) return;
  const config = await getCentralProviderConfigSafe(provider);
  res.json({ config });
}

export async function putCentralProviderTokenHandler(req: Request, res: Response): Promise<void> {
  const provider = getProviderOrRespond(req, res);
  if (!provider) return;
  const { environment, token } = req.body ?? {};
  if (!isValidEnvironment(environment)) {
    res.status(400).json({ error: "environment debe ser 'sandbox' o 'production'." });
    return;
  }
  if (!token || typeof token !== "string") {
    res.status(400).json({ error: "token es obligatorio." });
    return;
  }
  const config = await setCentralProviderToken({ provider, environment, token });
  res.json({ config });
}

export async function putCentralProviderEnvironmentHandler(req: Request, res: Response): Promise<void> {
  const provider = getProviderOrRespond(req, res);
  if (!provider) return;
  const { environment } = req.body ?? {};
  if (!isValidEnvironment(environment)) {
    res.status(400).json({ error: "environment debe ser 'sandbox' o 'production'." });
    return;
  }
  try {
    const config = await setCentralProviderEnvironment(provider, environment);
    res.json({ config });
  } catch (err) {
    if (err instanceof CentralProviderEnvironmentChangeBlockedError) {
      res.status(409).json({ error: err.message, pendingCount: err.pendingCount });
      return;
    }
    throw err;
  }
}

/**
 * Activa/desactiva este proveedor como el que `billingProviderFactory` resuelve para negocios
 * nuevos. Nunca activa producción implícitamente — producción se elige por separado con
 * `putCentralProviderEnvironmentHandler`, y el default de `active_environment` es "sandbox"
 * (`schema.prisma`, columna `active_environment`).
 */
export async function putCentralProviderActiveHandler(req: Request, res: Response): Promise<void> {
  const provider = getProviderOrRespond(req, res);
  if (!provider) return;
  const { isActive } = req.body ?? {};
  try {
    const config = await setCentralProviderActive(provider, Boolean(isActive));
    res.json({ config });
  } catch (err) {
    if (err instanceof CentralProviderActivationBlockedError) {
      res.status(409).json({ error: err.message });
      return;
    }
    throw err;
  }
}

export async function postValidateCentralProviderHandler(req: Request, res: Response): Promise<void> {
  const provider = getProviderOrRespond(req, res);
  if (!provider) return;
  const config = await validateCentralProviderConnectivity(provider);
  res.json({ config });
}

/** Diagnóstico de Sistemas 360 (WSFE/ARCA), no de la cuenta. */
export async function getArcaHealthHandler(req: Request, res: Response): Promise<void> {
  if (!getProviderOrRespond(req, res)) return;
  const health = await sistemas360HealthArca();
  res.json(health);
}
