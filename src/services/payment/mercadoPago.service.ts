import { MercadoPagoConfig, Preference, Payment } from 'mercadopago';
import type { Request } from 'express';
import crypto from 'crypto';
import { env } from '../../config/env';

export interface MpPreferenceResult {
  preferenceId: string;
  initPoint: string;
}

export interface MpPreferenceItem {
  id: string;
  title: string;
  quantity: number;
  unit_price: number;
  currency_id: string;
}

/** Crea una preference de Checkout Pro y devuelve el initPoint. */
export const createMpPreference = async (params: {
  accessToken: string;
  isSandbox: boolean;
  externalReference: string;
  items: MpPreferenceItem[];
  payerEmail?: string;
  businessId: string;
  notificationUrlBase?: string;
}): Promise<MpPreferenceResult> => {
  const client = new MercadoPagoConfig({ accessToken: params.accessToken });
  const preference = new Preference(client);

  const notificationBase = params.notificationUrlBase ?? env.MERCADO_PAGO_WEBHOOK_BASE_URL;
  const notificationUrl = notificationBase
    ? `${notificationBase}/api/payments/mercado-pago/webhook?business_id=${params.businessId}`
    : undefined;

  const result = await preference.create({
    body: {
      items: params.items,
      external_reference: params.externalReference,
      ...(notificationUrl ? { notification_url: notificationUrl } : {}),
      ...(params.payerEmail ? { payer: { email: params.payerEmail } } : {}),
      back_urls: {
        success: notificationBase ? `${notificationBase}/payment/success` : undefined,
        failure: notificationBase ? `${notificationBase}/payment/failure` : undefined,
        pending: notificationBase ? `${notificationBase}/payment/pending` : undefined,
      },
    },
  });

  const initPoint = params.isSandbox
    ? (result.sandbox_init_point ?? result.init_point ?? '')
    : (result.init_point ?? '');

  return {
    preferenceId: result.id ?? '',
    initPoint,
  };
};

/** Recupera el detalle de un pago de MP. */
export const fetchMpPayment = async (
  paymentId: string,
  accessToken: string
): Promise<Record<string, unknown>> => {
  const client = new MercadoPagoConfig({ accessToken });
  const payment = new Payment(client);
  const result = await payment.get({ id: Number(paymentId) });
  return result as unknown as Record<string, unknown>;
};

/**
 * Valida la firma del webhook de Mercado Pago.
 * Header `x-signature` formato: ts=<timestamp>,v1=<hmac>
 * Mensaje a firmar: id:<data.id>;request-id:<x-request-id>;ts:<ts>
 */
export const verifyMpWebhookSignature = (
  req: Request,
  webhookSecret: string
): boolean => {
  try {
    const signatureHeader = req.headers['x-signature'] as string | undefined;
    const requestId = req.headers['x-request-id'] as string | undefined;

    if (!signatureHeader) return false;

    const parts: Record<string, string> = {};
    for (const part of signatureHeader.split(',')) {
      const [k, v] = part.split('=');
      if (k && v) parts[k.trim()] = v.trim();
    }
    const ts = parts['ts'];
    const v1 = parts['v1'];
    if (!ts || !v1) return false;

    const body = req.body as { data?: { id?: string | number } };
    const dataId = String(body?.data?.id ?? '');
    const message = `id:${dataId};request-id:${requestId ?? ''};ts:${ts}`;

    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(message)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
  } catch {
    return false;
  }
};
