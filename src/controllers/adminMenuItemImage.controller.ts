import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  ImageValidationError,
  removeMenuItemImage,
  uploadMenuItemImage
} from "../services/menuItemImage.service";
import { getAdminMenuItemById } from "../services/adminMenuItems.service";

const idParamSchema = z.object({
  id: z.string().uuid()
});

function mapUploadError(error: unknown, res: Response): Response | null {
  const message = (error as Error).message;

  if (message === "MENU_ITEM_NOT_FOUND") {
    return res.status(404).json({ error: "Menu item no encontrado" });
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
 * POST /api/admin/menu-items/:id/image
 * multipart field: `image`
 */
export async function uploadMenuItemImageHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const file = req.file;
  if (!file?.buffer?.length) {
    return res.status(400).json({
      error: "Debes enviar un archivo en el campo multipart 'image'"
    });
  }

  try {
    const uploaded = await uploadMenuItemImage({
      businessId,
      menuItemId: parsedParams.data.id,
      buffer: file.buffer,
      declaredMime: file.mimetype
    });

    const row = await getAdminMenuItemById({
      businessId,
      id: parsedParams.data.id
    });

    return res.status(200).json({
      ...row,
      imageKey: uploaded.imageKey,
      imageUrl: uploaded.imageUrl
    });
  } catch (error) {
    const mapped = mapUploadError(error, res);
    if (mapped) return mapped;
    return next(error);
  }
}

/**
 * DELETE /api/admin/menu-items/:id/image
 */
export async function deleteMenuItemImageHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  try {
    await removeMenuItemImage({
      businessId,
      menuItemId: parsedParams.data.id
    });

    const row = await getAdminMenuItemById({
      businessId,
      id: parsedParams.data.id
    });

    return res.json(row);
  } catch (error) {
    const mapped = mapUploadError(error, res);
    if (mapped) return mapped;
    return next(error);
  }
}
