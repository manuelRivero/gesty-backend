/**
 * Cliente PedidosYa Courier (solo login + estimates).
 *
 * ESTADO: experimental / dormido. Sin credenciales no se invoca.
 * No crear shippings reales hasta validar el contrato comercial/API.
 */

import axios, { AxiosError, AxiosInstance } from 'axios';
import { env } from '../../config/env';
import {
  PedidosYaApiError,
  PedidosYaEstimateRequest,
  PedidosYaEstimateResponse,
  PedidosYaNotConfiguredError,
} from './types';

type TokenCache = {
  token: string;
  /** epoch ms; null = no conocemos expiración (token estático) */
  expiresAt: number | null;
};

let cachedToken: TokenCache | null = null;

/**
 * ¿Hay credenciales de plataforma suficientes para llamar a PedidosYa?
 * Acepta access token directo O par clientId + clientSecret.
 */
export function isPedidosYaCourierConfigured(): boolean {
  const token = env.PEDIDOSYA_ACCESS_TOKEN?.trim();
  if (token) return true;

  const clientId = env.PEDIDOSYA_CLIENT_ID?.trim();
  const clientSecret = env.PEDIDOSYA_CLIENT_SECRET?.trim();
  return Boolean(clientId && clientSecret);
}

function getBaseUrl(): string {
  return (
    env.PEDIDOSYA_COURIER_BASE_URL?.replace(/\/$/, '') ||
    'https://courier-api.pedidosya.com'
  );
}

function buildHttpClient(): AxiosInstance {
  return axios.create({
    baseURL: getBaseUrl(),
    timeout: 30_000,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
}

/**
 * PedidosYa Courier documenta `Authorization: <token>` (sin prefijo Bearer).
 * Algunos entornos aceptan Bearer; se controla con PEDIDOSYA_AUTH_HEADER_STYLE.
 */
function authorizationHeaderValue(token: string): string {
  const style = env.PEDIDOSYA_AUTH_HEADER_STYLE ?? 'raw';
  return style === 'bearer' ? `Bearer ${token}` : token;
}

function extractTokenFromLoginResponse(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;

  const candidates = [
    obj.accessToken,
    obj.access_token,
    obj.token,
    obj.authorization,
  ];

  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function extractExpiresInSeconds(data: unknown): number | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const raw = obj.expiresIn ?? obj.expires_in;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return null;
}

/**
 * Obtiene un token de acceso.
 *
 * Flujo preferido (credenciales de plataforma):
 *   POST /v3/login  { clientId, clientSecret }
 *
 * Override opcional: PEDIDOSYA_ACCESS_TOKEN (útil mientras averiguás el flujo exacto
 * o si PedidosYa te entrega un token de prueba).
 *
 * El path de login es configurable vía PEDIDOSYA_LOGIN_PATH por si el contrato
 * comercial usa otra ruta.
 */
async function fetchAccessToken(http: AxiosInstance): Promise<TokenCache> {
  const staticToken = env.PEDIDOSYA_ACCESS_TOKEN?.trim();
  if (staticToken) {
    return { token: staticToken, expiresAt: null };
  }

  const clientId = env.PEDIDOSYA_CLIENT_ID?.trim();
  const clientSecret = env.PEDIDOSYA_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    throw new PedidosYaNotConfiguredError();
  }

  const loginPath = env.PEDIDOSYA_LOGIN_PATH || '/v3/login';

  try {
    // Integración clave PedidosYa: login con client credentials de la cuenta SaaS.
    const { data, status } = await http.post(loginPath, {
      clientId,
      clientSecret,
    });

    const token = extractTokenFromLoginResponse(data);
    if (!token) {
      throw new PedidosYaApiError(
        'Login PedidosYa OK pero la respuesta no incluye token',
        status,
        data
      );
    }

    const expiresIn = extractExpiresInSeconds(data);
    // Renovar 60s antes del vencimiento real si conocemos expires_in.
    const expiresAt =
      expiresIn != null ? Date.now() + Math.max(expiresIn - 60, 30) * 1000 : null;

    return { token, expiresAt };
  } catch (err) {
    if (err instanceof PedidosYaApiError) throw err;
    throw toApiError(err, 'Error al autenticar contra PedidosYa Courier');
  }
}

async function getValidToken(http: AxiosInstance): Promise<string> {
  if (
    cachedToken &&
    (cachedToken.expiresAt == null || cachedToken.expiresAt > Date.now())
  ) {
    return cachedToken.token;
  }

  cachedToken = await fetchAccessToken(http);
  return cachedToken.token;
}

/** Invalida cache (p.ej. tras 401) para forzar re-login. */
export function clearPedidosYaTokenCache(): void {
  cachedToken = null;
}

function toApiError(err: unknown, fallbackMessage: string): PedidosYaApiError {
  if (err instanceof AxiosError) {
    const status = err.response?.status ?? 502;
    const body = err.response?.data;
    const detail =
      typeof body === 'object' && body && 'message' in body
        ? String((body as { message: unknown }).message)
        : err.message;
    return new PedidosYaApiError(`${fallbackMessage}: ${detail}`, status, body);
  }

  if (err instanceof Error) {
    return new PedidosYaApiError(`${fallbackMessage}: ${err.message}`, 502);
  }

  return new PedidosYaApiError(fallbackMessage, 502);
}

/**
 * Cotiza un envío (estimate) sin confirmarlo ni crear shipping real.
 * Endpoint: POST /v3/shippings/estimates
 *
 * Importante: usamos isTest según env para no generar envíos productivos
 * mientras calibramos tarifas planas del bot.
 */
export async function estimateShipping(
  body: PedidosYaEstimateRequest
): Promise<PedidosYaEstimateResponse> {
  if (!isPedidosYaCourierConfigured()) {
    throw new PedidosYaNotConfiguredError();
  }

  const http = buildHttpClient();
  const path = env.PEDIDOSYA_ESTIMATES_PATH || '/v3/shippings/estimates';

  const attempt = async (retried: boolean): Promise<PedidosYaEstimateResponse> => {
    const token = await getValidToken(http);

    try {
      const { data } = await http.post<PedidosYaEstimateResponse>(path, body, {
        headers: {
          Authorization: authorizationHeaderValue(token),
        },
      });
      return data;
    } catch (err) {
      if (
        !retried &&
        err instanceof AxiosError &&
        err.response?.status === 401 &&
        !env.PEDIDOSYA_ACCESS_TOKEN?.trim()
      ) {
        // Token vencido / inválido → re-login una vez.
        clearPedidosYaTokenCache();
        return attempt(true);
      }
      throw toApiError(err, 'Error al cotizar envío en PedidosYa');
    }
  };

  return attempt(false);
}

/**
 * Extrae el precio total más barato de las ofertas de una estimación.
 * Si no hay ofertas, retorna null (fuera de cobertura / sin flota).
 */
export function pickCheapestOfferTotal(
  estimate: PedidosYaEstimateResponse
): number | null {
  const offers = estimate.deliveryOffers ?? [];
  const totals = offers
    .map((o) => o.pricing?.total)
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n));

  if (totals.length === 0) return null;
  return Math.min(...totals);
}
