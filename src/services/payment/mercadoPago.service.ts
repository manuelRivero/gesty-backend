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
  /**
   * `undefined` → defaults bot bajo MERCADO_PAGO_WEBHOOK_BASE_URL.
   * `null` → omitir back_urls (storefront sin STOREFRONT_PUBLIC_ORIGIN).
   * objeto → esas URLs (sin merge con defaults).
   */
  backUrls?: {
    success?: string;
    failure?: string;
    pending?: string;
  } | null;
}): Promise<MpPreferenceResult> => {
  const client = new MercadoPagoConfig({ accessToken: params.accessToken });
  const preference = new Preference(client);

  const notificationBase = params.notificationUrlBase ?? env.MERCADO_PAGO_WEBHOOK_BASE_URL;
  const notificationUrl = notificationBase
    ? `${notificationBase}/api/payments/mercado-pago/webhook?business_id=${params.businessId}`
    : undefined;

  const defaultBack = notificationBase
    ? {
        success: `${notificationBase}/payment/success?business_id=${params.businessId}`,
        failure: `${notificationBase}/payment/failure?business_id=${params.businessId}`,
        pending: `${notificationBase}/payment/pending?business_id=${params.businessId}`,
      }
    : undefined;

  const back_urls =
    params.backUrls === null
      ? undefined
      : params.backUrls
        ? {
            success: params.backUrls.success,
            failure: params.backUrls.failure,
            pending: params.backUrls.pending,
          }
        : defaultBack;

  const auto_return =
    back_urls?.success && /^https?:\/\//i.test(back_urls.success)
      ? ('approved' as const)
      : undefined;

  console.log(
    JSON.stringify({
      event: '[mp-debug] preference_create_request',
      businessId: params.businessId,
      externalReference: params.externalReference,
      isSandbox: params.isSandbox,
      hasNotificationUrl: Boolean(notificationUrl),
      notificationUrl: notificationUrl ?? null,
      hasBackUrls: Boolean(back_urls),
      backUrls: back_urls ?? null,
      autoReturn: auto_return ?? null,
      itemCount: params.items.length,
    })
  );

  if (!notificationUrl) {
    console.warn(
      JSON.stringify({
        event: '[mp-debug] preference_without_notification_url',
        hint: 'Set MERCADO_PAGO_WEBHOOK_BASE_URL (public API URL). MP will not mark paid.',
        businessId: params.businessId,
        externalReference: params.externalReference,
      })
    );
  }

  const result = await preference.create({
    body: {
      items: params.items,
      external_reference: params.externalReference,
      ...(notificationUrl ? { notification_url: notificationUrl } : {}),
      ...(params.payerEmail ? { payer: { email: params.payerEmail } } : {}),
      ...(back_urls ? { back_urls } : {}),
      ...(auto_return ? { auto_return } : {}),
    },
  });

  const initPoint = params.isSandbox
    ? (result.sandbox_init_point ?? result.init_point ?? '')
    : (result.init_point ?? '');

  console.log(
    JSON.stringify({
      event: '[mp-debug] preference_create_result',
      businessId: params.businessId,
      externalReference: params.externalReference,
      preferenceId: result.id ?? null,
      hasInitPoint: Boolean(initPoint),
    })
  );

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
 *
 * Manifest (docs MP / SDK):
 *   id:<data.id>;request-id:<x-request-id>;ts:<ts>;
 * - `data.id` preferir query `data.id` (no solo body); lowercase.
 * - Omitir pares vacíos; siempre terminar en `;`.
 */
export const verifyMpWebhookSignature = (
  req: Request,
  webhookSecret: string
): boolean => {
  try {
    const signatureHeader = req.headers['x-signature'] as string | undefined;
    const requestIdRaw = req.headers['x-request-id'];
    const requestId = Array.isArray(requestIdRaw)
      ? requestIdRaw[0]
      : requestIdRaw;

    if (!signatureHeader) return false;

    const parts: Record<string, string> = {};
    for (const part of signatureHeader.split(',')) {
      const [k, ...rest] = part.split('=');
      const v = rest.join('=').trim();
      if (k && v) parts[k.trim()] = v;
    }
    const ts = parts['ts'];
    const v1 = parts['v1'];
    if (!ts || !v1) return false;

    const queryDataId = req.query['data.id'] ?? req.query.data_id;
    const queryId = Array.isArray(queryDataId) ? queryDataId[0] : queryDataId;
    const body = req.body as { data?: { id?: string | number } };
    const dataId = String(queryId ?? body?.data?.id ?? '')
      .trim()
      .toLowerCase();

    const manifestParts: string[] = [];
    if (dataId) manifestParts.push(`id:${dataId}`);
    if (requestId) manifestParts.push(`request-id:${requestId}`);
    manifestParts.push(`ts:${ts}`);
    const message = `${manifestParts.join(';')};`;

    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(message)
      .digest('hex');

    const a = Buffer.from(v1, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
};
