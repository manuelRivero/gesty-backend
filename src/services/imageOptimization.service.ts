import { randomUUID } from "node:crypto";
import sharp from "sharp";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_IMAGE_WIDTH_PX = 1600;
export const WEBP_QUALITY = 80;

export const ALLOWED_IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/webp"
] as const;

export type AllowedImageMime = (typeof ALLOWED_IMAGE_MIMES)[number];

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageValidationError";
  }
}

/**
 * Detecta MIME real por magic bytes. No confía en extensión ni Content-Type declarado.
 */
export function detectImageMime(buffer: Buffer): AllowedImageMime | null {
  if (buffer.length < 12) {
    return null;
  }

  // SVG / XML — rechazar explícitamente (no son imágenes raster permitidas)
  const head = buffer.subarray(0, Math.min(256, buffer.length)).toString("utf8").trimStart();
  if (
    head.startsWith("<?xml") ||
    head.startsWith("<svg") ||
    head.toLowerCase().startsWith("<!doctype svg")
  ) {
    return null;
  }

  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  // WEBP: RIFF....WEBP
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return null;
}

export function assertAllowedImage(buffer: Buffer, declaredMime?: string): AllowedImageMime {
  if (buffer.length === 0) {
    throw new ImageValidationError("El archivo de imagen está vacío");
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new ImageValidationError("La imagen supera el tamaño máximo de 5 MB");
  }

  const declared = (declaredMime ?? "").toLowerCase().trim();
  if (declared === "image/svg+xml" || declared.includes("svg")) {
    throw new ImageValidationError("No se permiten archivos SVG");
  }

  const detected = detectImageMime(buffer);
  if (!detected) {
    throw new ImageValidationError(
      "Formato de imagen no permitido. Solo se aceptan JPEG, PNG o WebP"
    );
  }

  if (declared && declared !== detected && !ALLOWED_IMAGE_MIMES.includes(declared as AllowedImageMime)) {
    throw new ImageValidationError(
      "El tipo de archivo declarado no coincide con una imagen permitida"
    );
  }

  return detected;
}

export type OptimizedImage = {
  /** WebP optimizado (sin EXIF). Buffer para poder enviar ContentLength a S3/R2. */
  body: Buffer;
  contentLength: number;
  contentType: "image/webp";
  extension: "webp";
};

/**
 * Convierte a WebP, elimina EXIF (re-encode), calidad 80, ancho máx. 1600px.
 * No persiste el original.
 *
 * Devuelve Buffer (no stream): el AWS SDK v3 exige ContentLength conocido
 * para PutObject; un stream de Sharp deja `x-amz-decoded-content-length` en undefined.
 */
export async function optimizeImageToWebp(buffer: Buffer): Promise<OptimizedImage> {
  assertAllowedImage(buffer);

  const body = await sharp(buffer, { failOn: "error" })
    .rotate() // aplica orientación EXIF y descarta metadatos al re-encodificar
    .resize({
      width: MAX_IMAGE_WIDTH_PX,
      withoutEnlargement: true
    })
    .webp({ quality: WEBP_QUALITY })
    .toBuffer();

  return {
    body,
    contentLength: body.length,
    contentType: "image/webp",
    extension: "webp"
  };
}

export function buildDishImageKey(businessId: string, extension = "webp"): string {
  return `restaurants/${businessId}/dishes/${randomUUID()}.${extension}`;
}
