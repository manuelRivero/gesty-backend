import type { Request, Response } from "express";
import { MenuCategoryTag } from "@prisma/client";
import { z } from "zod";
import {
  createAdminMenuItem,
  deleteAdminMenuItem,
  getAdminMenuItemById,
  listAdminMenuCategoriesOptions,
  listAdminMenuCategoryTagsOptions,
  listAdminMenuItems,
  updateAdminMenuItem
} from "../services/adminMenuItems.service";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  categoryId: z.string().uuid().optional(),
  q: z.string().min(1).optional(),
  includeUnavailable: z.coerce.boolean().optional().default(false),
  all: z.coerce.boolean().optional().default(false)
});

const createSchema = z.object({
  categoryId: z.string().uuid().optional(),
  categoryTag: z.nativeEnum(MenuCategoryTag).optional(),
  sectionId: z.nativeEnum(MenuCategoryTag).optional(),
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional().nullable(),
  ingredients: z.string().max(2000).optional().nullable(),
  preparation: z.string().max(3000).optional().nullable(),
  servesPeople: z.coerce.number().int().min(1).max(100).optional().nullable(),
  isFeatured: z.boolean().optional(),
  image: z.string().url().optional().nullable(),
  isAvailable: z.boolean().optional()
}).refine((data) => Boolean(data.categoryId || data.categoryTag || data.sectionId), {
  message: "Debe enviar categoryId o categoryTag/sectionId",
  path: ["categoryId"]
});

const idParamSchema = z.object({
  id: z.string().uuid()
});

const updateSchema = z.object({
  categoryId: z.string().uuid().optional(),
  categoryTag: z.nativeEnum(MenuCategoryTag).optional(),
  sectionId: z.nativeEnum(MenuCategoryTag).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).optional().nullable(),
  ingredients: z.string().max(2000).optional().nullable(),
  preparation: z.string().max(3000).optional().nullable(),
  servesPeople: z.coerce.number().int().min(1).max(100).optional().nullable(),
  isFeatured: z.boolean().optional(),
  image: z.string().url().optional().nullable(),
  isAvailable: z.boolean().optional()
});

export async function getMenuItems(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsed.error.flatten()
    });
  }

  const result = await listAdminMenuItems({
    businessId,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    categoryId: parsed.data.categoryId,
    q: parsed.data.q,
    includeUnavailable: parsed.data.includeUnavailable,
    all: parsed.data.all
  });

  return res.json(result);
}

export async function getMenuCategoriesOptions(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const items = await listAdminMenuCategoriesOptions({ businessId });
  return res.json({ items });
}

export async function getMenuCategoryTagsOptions(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const items = await listAdminMenuCategoryTagsOptions({ businessId });
  return res.json({ items });
}

export async function getMenuItemById(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await getAdminMenuItemById({
    businessId,
    id: parsedParams.data.id
  });

  if (!row) {
    return res.status(404).json({ error: "Menu item no encontrado" });
  }

  return res.json(row);
}

export async function postMenuItem(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsed.error.flatten()
    });
  }

  try {
    const row = await createAdminMenuItem({
      businessId,
      ...parsed.data,
      categoryTag: parsed.data.categoryTag ?? parsed.data.sectionId
    });
    return res.status(201).json(row);
  } catch (error) {
    if ((error as Error).message === "CATEGORY_NOT_FOUND") {
      return res.status(404).json({ error: "Categoría no encontrada" });
    }
    throw error;
  }
}

export async function patchMenuItem(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const parsedBody = updateSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsedBody.error.flatten()
    });
  }

  try {
    const row = await updateAdminMenuItem({
      businessId,
      id: parsedParams.data.id,
      ...parsedBody.data,
      categoryTag: parsedBody.data.categoryTag ?? parsedBody.data.sectionId
    });

    if (!row) {
      return res.status(404).json({ error: "Menu item no encontrado" });
    }
    return res.json(row);
  } catch (error) {
    if ((error as Error).message === "CATEGORY_NOT_FOUND") {
      return res.status(404).json({ error: "Categoría no encontrada" });
    }
    throw error;
  }
}

export async function removeMenuItem(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await deleteAdminMenuItem({
    businessId,
    id: parsedParams.data.id
  });

  if (!row) {
    return res.status(404).json({ error: "Menu item no encontrado" });
  }

  return res.json({
    success: true,
    id: row.id,
    isAvailable: row.is_available
  });
}
