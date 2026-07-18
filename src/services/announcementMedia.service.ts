import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma";
import { getStorageProvider } from "../storage";
import { assertAllowedImage, optimizeImageToWebp } from "./imageOptimization.service";

// ---------------------------------------------------------------------------
// Tipos MIME / limits para media de anuncios
// ---------------------------------------------------------------------------

export const MAX_MEDIA_BYTES_IMAGE = 10 * 1024 * 1024; // 10 MB
export const MAX_MEDIA_BYTES_VIDEO = 50 * 1024 * 1024; // 50 MB

/** MIME permitidos por tipo semántico. */
export const MEDIA_MIME_TYPES = {
  image: ["image/jpeg", "image/png", "image/webp"],
  gif: ["image/gif"],
  video: ["video/mp4", "video/webm"],
} as const;

type MediaType = "image" | "gif" | "video";

const ALL_ALLOWED_MIMES = [
  ...MEDIA_MIME_TYPES.image,
  ...MEDIA_MIME_TYPES.gif,
  ...MEDIA_MIME_TYPES.video,
];

/** Extensión canónica a partir del MIME real. */
const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

// ---------------------------------------------------------------------------
// Validación MIME por magic bytes
// ---------------------------------------------------------------------------

export class MediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaValidationError";
  }
}

function detectMediaMime(buffer: Buffer): string | null {
  if (buffer.length < 12) return null;

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";

  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) return "image/png";

  // WEBP (RIFF....WEBP)
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) return "image/webp";

  // GIF87a / GIF89a
  const gif = buffer.toString("ascii", 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";

  // MP4: ftyp box en bytes 4-8
  const ftyp = buffer.toString("ascii", 4, 8);
  if (ftyp === "ftyp") return "video/mp4";

  // WebM: EBML header 0x1A 0x45 0xDF 0xA3
  if (
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) return "video/webm";

  return null;
}

function resolveMediaType(mime: string): MediaType {
  if ((MEDIA_MIME_TYPES.image as readonly string[]).includes(mime)) return "image";
  if ((MEDIA_MIME_TYPES.gif as readonly string[]).includes(mime)) return "gif";
  return "video";
}

function assertAllowedMedia(
  buffer: Buffer,
  declaredMime: string
): { mime: string; mediaType: MediaType } {
  const decl = declaredMime.toLowerCase().trim();

  if (decl === "image/svg+xml" || decl.includes("svg")) {
    throw new MediaValidationError("No se permiten archivos SVG");
  }

  const detected = detectMediaMime(buffer);
  const mime = detected ?? decl;

  if (!ALL_ALLOWED_MIMES.includes(mime as (typeof ALL_ALLOWED_MIMES)[number])) {
    throw new MediaValidationError(
      "Tipo de archivo no permitido. Se aceptan: JPEG, PNG, WebP, GIF, MP4 o WebM"
    );
  }

  const mediaType = resolveMediaType(mime);

  const maxBytes =
    mediaType === "video" ? MAX_MEDIA_BYTES_VIDEO : MAX_MEDIA_BYTES_IMAGE;

  if (buffer.length > maxBytes) {
    const maxMb = maxBytes / (1024 * 1024);
    throw new MediaValidationError(
      `El archivo supera el tamaño máximo de ${maxMb} MB`
    );
  }

  return { mime, mediaType };
}

// ---------------------------------------------------------------------------
// Helpers R2
// ---------------------------------------------------------------------------

function buildAnnouncementMediaKey(announcementId: string, ext: string): string {
  return `platform/announcements/${announcementId}/${randomUUID()}.${ext}`;
}

async function deleteMediaBestEffort(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await getStorageProvider().delete(key);
  } catch (err) {
    console.error("[announcement-media] Error al eliminar objeto (se ignora):", { key, err });
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type AnnouncementMediaResult = {
  mediaKey: string;
  mediaUrl: string;
  mediaType: MediaType;
  mediaMime: string;
};

/**
 * Sube el adjunto al anuncio y actualiza la fila en BD.
 * - Imágenes estáticas → WebP optimizado.
 * - GIF y video → sin conversión.
 */
export async function uploadAnnouncementMedia(params: {
  announcementId: string;
  buffer: Buffer;
  declaredMime: string;
}): Promise<AnnouncementMediaResult> {
  const row = await prisma.announcement.findUnique({
    where: { id: params.announcementId },
    select: { id: true, media_key: true },
  });

  if (!row) throw new Error("ANNOUNCEMENT_NOT_FOUND");

  const { mime, mediaType } = assertAllowedMedia(params.buffer, params.declaredMime);

  let uploadBody: Buffer = params.buffer;
  let uploadMime: string = mime;
  let ext = MIME_TO_EXT[mime] ?? "bin";

  if (mediaType === "image") {
    // Reutiliza el validador de imágenes y optimiza a WebP
    assertAllowedImage(params.buffer, mime);
    const optimized = await optimizeImageToWebp(params.buffer);
    uploadBody = optimized.body;
    uploadMime = optimized.contentType;
    ext = optimized.extension;
  }

  const key = buildAnnouncementMediaKey(params.announcementId, ext);
  const storage = getStorageProvider();

  await storage.upload({
    key,
    body: uploadBody,
    contentType: uploadMime,
    contentLength: uploadBody.length,
  });

  const mediaUrl = storage.getPublicUrl(key);
  const previousKey = row.media_key;

  await prisma.announcement.update({
    where: { id: params.announcementId },
    data: {
      media_key: key,
      media_url: mediaUrl,
      media_type: mediaType,
      media_mime: uploadMime,
    },
  });

  if (previousKey && previousKey !== key) {
    await deleteMediaBestEffort(previousKey);
  }

  return { mediaKey: key, mediaUrl, mediaType, mediaMime: uploadMime };
}

/** Elimina el adjunto en R2 y limpia los campos media en BD. */
export async function removeAnnouncementMedia(announcementId: string): Promise<void> {
  const row = await prisma.announcement.findUnique({
    where: { id: announcementId },
    select: { id: true, media_key: true },
  });

  if (!row) throw new Error("ANNOUNCEMENT_NOT_FOUND");

  await prisma.announcement.update({
    where: { id: announcementId },
    data: { media_key: null, media_url: null, media_type: null, media_mime: null },
  });

  await deleteMediaBestEffort(row.media_key);
}

export { deleteMediaBestEffort };
