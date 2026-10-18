import type { NextFunction, Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  ImageValidationError,
  removeBusinessImage,
  uploadBusinessImage
} from "../services/businessImage.service";
import { ADMIN_BUSINESS_SELECT } from "./adminBusiness.controller";

function mapUploadError(error: unknown, res: Response): Response | null {
  const message = (error as Error).message;

  if (message === "BUSINESS_NOT_FOUND") {
    return res.status(404).json({ error: "Business no encontrado" });
  }
  if (message?.startsWith("STORAGE_NOT_CONFIGURED")) {
    return res.status(503).json({
      error: "Almacenamiento de imágenes no configurado en el servidor"
    });
  }
  if (error instanceof ImageValidationError) {
    return res.status(400).json({ error: error.message });
  }
  return null;
}

/**
 * POST /api/admin/business/image
 * multipart field: `image`
 */
export async function uploadBusinessImageHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const file = req.file;
  if (!file?.buffer?.length) {
    return res.status(400).json({
      error: "Debes enviar un archivo en el campo multipart 'image'"
    });
  }

  try {
    await uploadBusinessImage({
      businessId,
      buffer: file.buffer,
      declaredMime: file.mimetype
    });

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: ADMIN_BUSINESS_SELECT
    });

    return res.status(200).json(business);
  } catch (error) {
    const mapped = mapUploadError(error, res);
    if (mapped) return mapped;
    return next(error);
  }
}

/**
 * DELETE /api/admin/business/image
 */
export async function deleteBusinessImageHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  try {
    await removeBusinessImage({ businessId });

    const business = await prisma.business.findUnique({
      where: { id: businessId },
      select: ADMIN_BUSINESS_SELECT
    });

    return res.json(business);
  } catch (error) {
    const mapped = mapUploadError(error, res);
    if (mapped) return mapped;
    return next(error);
  }
}
