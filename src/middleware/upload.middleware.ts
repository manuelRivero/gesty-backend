import type { NextFunction, Request, Response } from "express";
import multer from "multer";
import { MAX_IMAGE_BYTES } from "../services/imageOptimization.service";

/**
 * Multipart para imágenes de platillos.
 * Límite 5 MB; el MIME real se valida después por magic bytes (no por extensión).
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_IMAGE_BYTES,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || "").toLowerCase();
    if (mime === "image/svg+xml" || mime.includes("svg")) {
      cb(new Error("IMAGE_SVG_NOT_ALLOWED"));
      return;
    }
    if (
      mime === "image/jpeg" ||
      mime === "image/png" ||
      mime === "image/webp" ||
      mime === "application/octet-stream"
    ) {
      cb(null, true);
      return;
    }
    cb(new Error("IMAGE_MIME_NOT_ALLOWED"));
  }
});

function mapMulterError(error: unknown): { status: number; error: string } | null {
  const message = (error as Error)?.message ?? "";
  if (message === "IMAGE_SVG_NOT_ALLOWED") {
    return { status: 400, error: "No se permiten archivos SVG" };
  }
  if (message === "IMAGE_MIME_NOT_ALLOWED") {
    return {
      status: 400,
      error: "Tipo de archivo no permitido. Solo se aceptan JPEG, PNG o WebP"
    };
  }
  if (
    (error as { code?: string })?.code === "LIMIT_FILE_SIZE" ||
    message.includes("File too large")
  ) {
    return { status: 400, error: "La imagen supera el tamaño máximo de 5 MB" };
  }
  return null;
}

/** Middleware Express que parsea el campo multipart `image` y traduce errores de multer. */
export function menuItemImageUploadMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  upload.single("image")(req, res, (err: unknown) => {
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
