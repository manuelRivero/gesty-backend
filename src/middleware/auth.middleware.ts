import type { BusinessUserRole } from "../types/auth";
import type { NextFunction, Request, Response } from "express";
import { getAccessTokenFromCookies } from "../lib/authCookies";
import { verifyAccessToken } from "../services/auth.service";

const BEARER = /^Bearer\s+(.+)$/i;

function getBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header || typeof header !== "string") {
    return undefined;
  }
  const match = BEARER.exec(header.trim());
  return match?.[1];
}

/**
 * Token: `Authorization: Bearer <jwt>` o cookie HttpOnly (nombre por defecto `access_token`).
 * Tras este middleware, las rutas de tenant deben acotar datos con
 * `business_id = req.user.businessId` (salvo `SUPER_ADMIN`, donde puede ser `null`).
 */
export function authenticateJwt(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const token =
    getBearerToken(req) ?? getAccessTokenFromCookies(req);
  if (!token) {
    res.status(401).json({ error: "Token no proporcionado" });
    return;
  }
  try {
    const payload = verifyAccessToken(token);
    req.user = {
      userId: payload.userId,
      businessId: payload.businessId,
      role: payload.role
    };
    next();
  } catch {
    res.status(401).json({ error: "Token inválido o expirado" });
  }
}

/** `businessId` del tenant autenticado (solo tras `authenticateJwt`). */
export function tenantBusinessId(req: Request): string {
  const id = req.user?.businessId;
  if (!id) {
    throw new Error("TENANT_CONTEXT");
  }
  return id;
}

export function requireRoles(...allowed: BusinessUserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "No autenticado" });
      return;
    }
    if (!allowed.includes(req.user.role)) {
      res.status(403).json({ error: "Permiso denegado" });
      return;
    }
    next();
  };
}
