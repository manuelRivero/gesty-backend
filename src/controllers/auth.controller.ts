import type { Request, Response } from "express";
import { z } from "zod";
import {
  clearAuthCookies,
  getRefreshTokenFromCookies,
  setAuthCookies
} from "../lib/authCookies";
import {
  login,
  logout,
  refreshAccessToken
} from "../services/auth.service";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  businessId: z.string().uuid().optional()
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1).optional()
});

export async function postLogin(req: Request, res: Response) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "email y password son obligatorios" });
  }
  const { email, password, businessId } = parsed.data;
  try {
    const tokens = await login(email, password, businessId);
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    return res.json(tokens);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "INVALID_CREDENTIALS") {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }
    if (msg === "NO_MEMBERSHIPS") {
      return res.status(403).json({ error: "El usuario no tiene negocios asignados" });
    }
    if (msg === "BUSINESS_ID_REQUIRED") {
      return res.status(400).json({
        error:
          "Indica businessId: el usuario pertenece a más de un negocio"
      });
    }
    if (msg === "MEMBERSHIP_NOT_FOUND") {
      return res.status(403).json({ error: "No tienes acceso a ese negocio" });
    }
    if (msg === "INVALID_MEMBERSHIP_ROLE") {
      return res.status(500).json({ error: "Rol de cuenta inválido" });
    }
    throw e;
  }
}

export async function postRefresh(req: Request, res: Response) {
  const parsed = refreshSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Cuerpo inválido" });
  }
  const refreshToken =
    parsed.data.refreshToken?.trim() ||
    getRefreshTokenFromCookies(req);
  if (!refreshToken) {
    return res.status(400).json({
      error: "refreshToken en body o cookie obligatorio"
    });
  }
  try {
    const out = await refreshAccessToken(refreshToken);
    setAuthCookies(res, out.accessToken, refreshToken);
    return res.json(out);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "INVALID_REFRESH_TOKEN" || msg === "SESSION_INVALID") {
      return res.status(401).json({ error: "Refresh token inválido o sesión cerrada" });
    }
    throw e;
  }
}

export async function postLogout(req: Request, res: Response) {
  const parsed = refreshSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ error: "Cuerpo inválido" });
  }
  const refreshToken =
    parsed.data.refreshToken?.trim() ||
    getRefreshTokenFromCookies(req);
  if (!refreshToken) {
    clearAuthCookies(res);
    return res.status(204).send();
  }
  try {
    await logout(refreshToken);
    clearAuthCookies(res);
    return res.status(204).send();
  } catch (e) {
    if ((e as Error).message === "INVALID_REFRESH_TOKEN") {
      clearAuthCookies(res);
      return res.status(401).json({ error: "Refresh token inválido" });
    }
    throw e;
  }
}
