/**
 * Descarga de media entrante de la WhatsApp Cloud API.
 *
 * Meta requiere dos pasos, ambos autenticados con el mismo Bearer token:
 *   1. GET /{media-id}          → metadata (url temporal, mime_type, sha256, file_size)
 *   2. GET <url>                → bytes reales (la URL también exige Authorization)
 *
 * La URL del paso 1 expira en pocos minutos; no se debe cachear ni reutilizar.
 */

import { env } from '../../config/env';
import { detectImageMime } from '../../services/imageOptimization.service';

export const WHATSAPP_GRAPH_BASE_URL = 'https://graph.facebook.com/v18.0';

/** Tope duro de tamaño para media entrante (límite de imágenes de WhatsApp). */
export const MAX_INBOUND_MEDIA_BYTES = 5 * 1024 * 1024; // 5 MB

export const ALLOWED_INBOUND_MEDIA_MIMES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type WhatsAppMediaFile = {
  buffer: Buffer;
  mimeType: string;
  sha256: string;
  sizeBytes: number;
};

export type WhatsAppMediaErrorCode =
  | 'MEDIA_TOO_LARGE'
  | 'MEDIA_UNSUPPORTED_TYPE'
  | 'MEDIA_DOWNLOAD_FAILED';

export class WhatsAppMediaError extends Error {
  readonly code: WhatsAppMediaErrorCode;

  constructor(code: WhatsAppMediaErrorCode, message: string) {
    super(message);
    this.name = 'WhatsAppMediaError';
    this.code = code;
  }
}

type WhatsAppMediaMetadata = {
  url: string;
  mime_type: string;
  sha256: string;
  file_size: number;
  id: string;
};

function requireAccessToken(): string {
  const token = env.WHATSAPP_ACCESS_TOKEN;
  if (!token) {
    throw new WhatsAppMediaError(
      'MEDIA_DOWNLOAD_FAILED',
      'WHATSAPP_ACCESS_TOKEN no está definida'
    );
  }
  return token;
}

async function fetchMediaMetadata(
  mediaId: string,
  token: string
): Promise<WhatsAppMediaMetadata> {
  const res = await fetch(`${WHATSAPP_GRAPH_BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new WhatsAppMediaError(
      'MEDIA_DOWNLOAD_FAILED',
      `Error obteniendo metadata de media ${mediaId}: ${res.status} ${detail}`
    );
  }

  return (await res.json()) as WhatsAppMediaMetadata;
}

async function fetchMediaBytes(url: string, token: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new WhatsAppMediaError(
      'MEDIA_DOWNLOAD_FAILED',
      `Error descargando bytes de media: ${res.status} ${detail}`
    );
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Descarga un adjunto entrante de WhatsApp validando tamaño y tipo antes y
 * después de bajar los bytes. Lanza `WhatsAppMediaError` ante cualquier
 * condición no aceptable; no hace fallback silencioso.
 */
export const downloadWhatsAppMedia = async (
  mediaId: string
): Promise<WhatsAppMediaFile> => {
  const token = requireAccessToken();

  const metadata = await fetchMediaMetadata(mediaId, token);

  if (
    typeof metadata.file_size === 'number' &&
    metadata.file_size > MAX_INBOUND_MEDIA_BYTES
  ) {
    throw new WhatsAppMediaError(
      'MEDIA_TOO_LARGE',
      `El archivo supera el tamaño máximo de ${MAX_INBOUND_MEDIA_BYTES} bytes (declarado: ${metadata.file_size})`
    );
  }

  const buffer = await fetchMediaBytes(metadata.url, token);

  if (buffer.length > MAX_INBOUND_MEDIA_BYTES) {
    throw new WhatsAppMediaError(
      'MEDIA_TOO_LARGE',
      `El archivo descargado supera el tamaño máximo de ${MAX_INBOUND_MEDIA_BYTES} bytes`
    );
  }

  const detectedMime = detectImageMime(buffer);
  if (
    !detectedMime ||
    !(ALLOWED_INBOUND_MEDIA_MIMES as readonly string[]).includes(detectedMime)
  ) {
    throw new WhatsAppMediaError(
      'MEDIA_UNSUPPORTED_TYPE',
      'Tipo de archivo no permitido. Se aceptan: JPEG, PNG o WebP'
    );
  }

  return {
    buffer,
    mimeType: detectedMime,
    sha256: metadata.sha256,
    sizeBytes: buffer.length,
  };
};
