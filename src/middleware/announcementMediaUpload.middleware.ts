import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import {
  MAX_MEDIA_BYTES_IMAGE,
  MAX_MEDIA_BYTES_VIDEO,
} from "../services/announcementMedia.service";

/**
 * Multer para adjuntos de anuncios (imagen, GIF o video).
 * El límite se establece en el mayor de los dos (video 50 MB) para que multer
 * no rechace antes de que el service valide el tipo real.
 * La validación por MIME real y tamaño exacto se hace en announcementMedia.service.
 */
const MAX_BYTES = Math.max(MAX_MEDIA_BYTES_IMAGE, MAX_MEDIA_BYTES_VIDEO);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_BYTES,
    files: 1,
  },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype ?? "").toLowerCase();

    if (mime === "image/svg+xml" || mime.includes("svg")) {
      cb(new Error("MEDIA_SVG_NOT_ALLOWED"));
      return;
    }

    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "video/mp4",
      "video/webm",
      "application/octet-stream",
    ];

    if (!allowed.includes(mime)) {
      cb(new Error("MEDIA_MIME_NOT_ALLOWED"));
      return;
    }

    cb(null, true);
  },
});

function mapMulterError(error: unknown): { status: number; error: string } | null {
  const message = (error as Error)?.message ?? "";
  if (message === "MEDIA_SVG_NOT_ALLOWED") {
    return { status: 400, error: "No se permiten archivos SVG" };
  }
  if (message === "MEDIA_MIME_NOT_ALLOWED") {
    return {
      status: 400,
      error: "Tipo de archivo no permitido. Se aceptan: JPEG, PNG, WebP, GIF, MP4 o WebM",
    };
  }
  if (
    (error as { code?: string })?.code === "LIMIT_FILE_SIZE" ||
    message.includes("File too large")
  ) {
    return {
      status: 400,
      error: "El archivo supera el tamaño máximo permitido (50 MB para video, 10 MB para imagen/GIF)",
    };
  }
  return null;
}

/** Middleware que parsea el campo multipart `media` y traduce errores de multer. */
export function announcementMediaUploadMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  upload.single("media")(req, res, (err: unknown) => {
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
