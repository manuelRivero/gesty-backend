/**
 * Cliente del sistema de Embajadores de Domingo Sabrosón.
 *
 * El agente de WhatsApp no calcula ni decide comisiones: solo valida códigos
 * públicos y notifica ventas ya pagadas. Domingo Sabrosón es la única fuente
 * de verdad sobre si corresponde comisión.
 */

import axios, { AxiosError, AxiosInstance } from 'axios';
import { env } from '../../config/env';
import {
  AmbassadorsApiError,
  AmbassadorsNotConfiguredError,
  AmbassadorValidateRequest,
  AmbassadorValidateResponse,
  RegisterSaleRequest,
  RegisterSaleResponse,
} from './types';

export function isAmbassadorsClientConfigured(): boolean {
  return Boolean(env.AMBASSADORS_API_BASE_URL?.trim());
}

function getBaseUrl(): string {
  const base = env.AMBASSADORS_API_BASE_URL?.trim();
  if (!base) {
    throw new AmbassadorsNotConfiguredError();
  }
  return base.replace(/\/$/, '');
}

function buildHttpClient(): AxiosInstance {
  return axios.create({
    baseURL: getBaseUrl(),
    timeout: env.AMBASSADORS_TIMEOUT_MS,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });
}

function authHeaders(): Record<string, string> {
  const key = env.AMBASSADORS_API_KEY?.trim();
  if (!key) return {};
  return env.AMBASSADORS_AUTH_HEADER === 'api_key'
    ? { 'x-api-key': key }
    : { Authorization: `Bearer ${key}` };
}

function toApiError(err: unknown, fallbackMessage: string): AmbassadorsApiError {
  if (err instanceof AxiosError) {
    // Sin response (timeout, DNS, conexión rechazada) → 502, tratado como transitorio.
    const status = err.response?.status ?? 502;
    const body = err.response?.data;
    const detail =
      typeof body === 'object' && body && 'message' in body
        ? String((body as { message: unknown }).message)
        : err.message;
    return new AmbassadorsApiError(`${fallbackMessage}: ${detail}`, status, body);
  }
  if (err instanceof Error) {
    return new AmbassadorsApiError(`${fallbackMessage}: ${err.message}`, 502);
  }
  return new AmbassadorsApiError(fallbackMessage, 502);
}

/**
 * `POST /api/v1/public/ambassadors/validate` — sin autenticación.
 * Devuelve `{ valid: false }` para código inexistente/inactivo, nunca lanza
 * por eso (solo lanza por errores de transporte/servidor).
 */
export async function validateAmbassadorCode(
  code: string
): Promise<AmbassadorValidateResponse> {
  const http = buildHttpClient();
  const body: AmbassadorValidateRequest = { code };
  try {
    const { data } = await http.post<AmbassadorValidateResponse>(
      '/api/v1/public/ambassadors/validate',
      body
    );
    return data;
  } catch (err) {
    throw toApiError(err, 'Error al validar código de embajador');
  }
}

/**
 * `POST /api/v1/integrations/ambassadors/register-sale` — protegido con
 * `Authorization: Bearer <token>` o `x-api-key: <key>` (según
 * `AMBASSADORS_AUTH_HEADER`). La auth puede no estar activa aún en dev:
 * enviamos el header si hay `AMBASSADORS_API_KEY` configurada.
 *
 * `commissionCreated: false` es una respuesta 200 válida (ver `reason` en el
 * contrato), no un error del agente.
 */
export async function registerAmbassadorSale(
  payload: RegisterSaleRequest
): Promise<RegisterSaleResponse> {
  const http = buildHttpClient();
  try {
    const { data } = await http.post<RegisterSaleResponse>(
      '/api/v1/integrations/ambassadors/register-sale',
      payload,
      { headers: authHeaders() }
    );
    return data;
  } catch (err) {
    throw toApiError(err, 'Error al registrar venta de embajador');
  }
}
