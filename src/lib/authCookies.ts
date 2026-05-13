import { parse, serialize, type SerializeOptions } from "cookie";
import type { Request, Response } from "express";

/** Nombres de cookie (alinear con el middleware del admin en Next). */
export const ACCESS_COOKIE_NAME =
  process.env.AUTH_ACCESS_COOKIE_NAME ?? "access_token";
export const REFRESH_COOKIE_NAME =
  process.env.AUTH_REFRESH_COOKIE_NAME ?? "refresh_token";

const ACCESS_MAX_AGE_SEC =
  Number(process.env.AUTH_ACCESS_COOKIE_MAX_AGE) || 4 * 60 * 60;
const REFRESH_MAX_AGE_SEC =
  Number(process.env.AUTH_REFRESH_COOKIE_MAX_AGE) || 8 * 60 * 60;

function cookieBaseSerializeOptions(): SerializeOptions {
  const sameSiteRaw = process.env.AUTH_COOKIE_SAMESITE;
  const sameSite: "lax" | "strict" | "none" =
    sameSiteRaw === "strict" || sameSiteRaw === "none" || sameSiteRaw === "lax"
      ? sameSiteRaw
      : "lax";
  const secure =
    process.env.AUTH_COOKIE_SECURE === "true" ||
    process.env.NODE_ENV === "production" ||
    sameSite === "none";
  const domain = process.env.AUTH_COOKIE_DOMAIN?.trim() || undefined;
  return {
    httpOnly: true,
    secure,
    path: "/",
    sameSite,
    ...(domain ? { domain } : {})
  };
}

export function parseCookies(req: Request): Record<string, string | undefined> {
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== "string") {
    return {};
  }
  return parse(raw);
}

export function getAccessTokenFromCookies(req: Request): string | undefined {
  const v = parseCookies(req)[ACCESS_COOKIE_NAME];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function getRefreshTokenFromCookies(req: Request): string | undefined {
  const v = parseCookies(req)[REFRESH_COOKIE_NAME];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function setAuthCookies(
  res: Response,
  accessToken: string,
  refreshToken: string
): void {
  const base = cookieBaseSerializeOptions();
  res.append(
    "Set-Cookie",
    serialize(ACCESS_COOKIE_NAME, accessToken, {
      ...base,
      maxAge: ACCESS_MAX_AGE_SEC
    })
  );
  res.append(
    "Set-Cookie",
    serialize(REFRESH_COOKIE_NAME, refreshToken, {
      ...base,
      maxAge: REFRESH_MAX_AGE_SEC
    })
  );
}

export function clearAuthCookies(res: Response): void {
  const base = cookieBaseSerializeOptions();
  res.append(
    "Set-Cookie",
    serialize(ACCESS_COOKIE_NAME, "", { ...base, maxAge: 0 })
  );
  res.append(
    "Set-Cookie",
    serialize(REFRESH_COOKIE_NAME, "", { ...base, maxAge: 0 })
  );
}
