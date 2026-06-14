import type { Request, Response } from 'express';
import { getMpBannerDataUrl } from '../assets/mpBanner';
import { isPaymentProviderId } from '../services/payment/paymentProviders';

const PROVIDER_LOGO_DATA_URL: Partial<Record<string, () => string>> = {
  mercado_pago: getMpBannerDataUrl,
};

export async function getPaymentProviderLogo(req: Request, res: Response) {
  const providerParam = req.params.provider;
  const provider = Array.isArray(providerParam) ? providerParam[0] : providerParam;

  if (!provider || !isPaymentProviderId(provider)) {
    return res.status(404).json({ error: 'Proveedor no encontrado' });
  }

  const getDataUrl = PROVIDER_LOGO_DATA_URL[provider];
  if (!getDataUrl) {
    return res.status(404).json({ error: 'Logo no disponible' });
  }

  const base64 = getDataUrl().split(',')[1];
  const buffer = Buffer.from(base64, 'base64');

  res.type('image/png');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  return res.send(buffer);
}
