import fs from 'node:fs';
import path from 'node:path';

let _cached: string | null = null;

/** Devuelve el data URL (image/png base64) del banner de Mercado Pago. */
export const getMpBannerDataUrl = (): string => {
  if (_cached) return _cached;
  const imgPath = path.join(__dirname, 'mp-banner.png');
  const b64 = fs.readFileSync(imgPath).toString('base64');
  _cached = `data:image/png;base64,${b64}`;
  return _cached;
};
