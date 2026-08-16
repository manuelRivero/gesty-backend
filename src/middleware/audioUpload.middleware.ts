import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';

/** Límite V1 para audio del panel admin (voice notes / grabaciones cortas). */
export const MAX_PROMOTION_AUDIO_BYTES = 10 * 1024 * 1024;

const ALLOWED_AUDIO_MIMES = new Set([
  'audio/ogg',
  'audio/opus',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/amr',
  'audio/wav',
  'audio/x-wav',
  'audio/webm',
  'application/octet-stream',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_PROMOTION_AUDIO_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase().split(';')[0]!.trim();
    if (ALLOWED_AUDIO_MIMES.has(mime)) {
      cb(null, true);
      return;
    }
    cb(new Error('AUDIO_MIME_NOT_ALLOWED'));
  },
});

function mapMulterError(error: unknown): { status: number; error: string } | null {
  const message = (error as Error)?.message ?? '';
  if (message === 'AUDIO_MIME_NOT_ALLOWED') {
    return {
      status: 400,
      error:
        'Tipo de audio no permitido. Usá OGG, MP3, M4A, WAV, AAC, AMR o WEBM',
    };
  }
  if (
    (error as { code?: string })?.code === 'LIMIT_FILE_SIZE' ||
    message.includes('File too large')
  ) {
    return { status: 400, error: 'El audio supera el tamaño máximo de 10 MB' };
  }
  return null;
}

/**
 * Multipart para audio de interpretación de promociones.
 * Campo esperado: `audio`. El MIME real se valida después por magic bytes.
 */
export function promotionAudioUploadMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  upload.single('audio')(req, res, (err: unknown) => {
    if (err) {
      const mapped = mapMulterError(err);
      if (mapped) {
        res.status(mapped.status).json({ error: mapped.error });
        return;
      }
      next(err);
      return;
    }
    next();
  });
}

/**
 * Detecta MIME de audio por magic bytes. No confía en la extensión ni en el
 * Content-Type declarado por el cliente.
 */
export function detectAudioMimeFromBuffer(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  // OGG
  if (
    buffer[0] === 0x4f &&
    buffer[1] === 0x67 &&
    buffer[2] === 0x67 &&
    buffer[3] === 0x53
  ) {
    return 'audio/ogg';
  }

  // WAV (RIFF....WAVE)
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x41 &&
    buffer[10] === 0x56 &&
    buffer[11] === 0x45
  ) {
    return 'audio/wav';
  }

  // WEBM / Matroska
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return 'audio/webm';
  }

  // MP3 con ID3
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) {
    return 'audio/mpeg';
  }

  // MP3 frame sync
  if (buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0) {
    return 'audio/mpeg';
  }

  // MP4 / M4A (....ftyp)
  if (
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70
  ) {
    return 'audio/mp4';
  }

  return null;
}
