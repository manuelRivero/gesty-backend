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
  updateAdminMenuItem,
  type DiscountInput
} from "../services/adminMenuItems.service";
import { generateMenuItemEnrichment } from "../services/ai/menuItemEnrichment.service";
import {
  getMenuItemAiMetadata,
  saveMenuItemAiMetadata
} from "../services/adminMenuItemAiMetadata.service";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  categoryId: z.string().uuid().optional(),
  q: z.string().min(1).optional(),
  includeUnavailable: z.coerce.boolean().optional().default(false),
  all: z.coerce.boolean().optional().default(false)
});

const menuItemPriceSchema = z.object({
  amount: z.coerce.number().positive(),
  currencyCode: z.string().trim().length(3).optional()
});

const discountSchema = z
  .object({
    discountType: z.enum(['PERCENT', 'FIXED']),
    discountValue: z.coerce.number().positive()
  })
  .refine(
    (val) => !(val.discountType === 'PERCENT' && val.discountValue > 100),
    { message: 'El porcentaje de descuento no puede superar el 100%', path: ['discountValue'] }
  )
  .nullable()
  .optional();

// D8 — máximo 10 variaciones: es el límite de filas de una lista de
// WhatsApp sin paginado (ver PLAN-ACCION-VARIACIONES-PLATILLOS.md).
const variationsSchema = z
  .array(z.string().trim().min(1).max(60))
  .max(10)
  .nullable()
  .optional();

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
  isAvailable: z.boolean().optional(),
  price: menuItemPriceSchema.optional(),
  discount: discountSchema,
  variations: variationsSchema
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
  isAvailable: z.boolean().optional(),
  price: menuItemPriceSchema.optional(),
  discount: discountSchema,
  variations: variationsSchema
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
      categoryTag: parsed.data.categoryTag ?? parsed.data.sectionId,
      price: parsed.data.price,
      discount: (parsed.data.discount as DiscountInput | null | undefined) ?? null,
    });
    if (!row) {
      return res.status(500).json({ error: "No se pudo recuperar el producto creado" });
    }
    return res.status(201).json(row);
  } catch (error) {
    if ((error as Error).message === "CATEGORY_NOT_FOUND") {
      return res.status(404).json({ error: "Categoría no encontrada" });
    }
    if ((error as Error).message === "BUSINESS_CURRENCY_NOT_SET") {
      return res.status(400).json({
        error: "El negocio no tiene moneda configurada. Indique currencyCode en price."
      });
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
      categoryTag: parsedBody.data.categoryTag ?? parsedBody.data.sectionId,
      price: parsedBody.data.price,
      discount: (parsedBody.data.discount as DiscountInput | null | undefined),
    });

    if (!row) {
      return res.status(404).json({ error: "Menu item no encontrado" });
    }
    return res.json(row);
  } catch (error) {
    if ((error as Error).message === "CATEGORY_NOT_FOUND") {
      return res.status(404).json({ error: "Categoría no encontrada" });
    }
    if ((error as Error).message === "BUSINESS_CURRENCY_NOT_SET") {
      return res.status(400).json({
        error: "El negocio no tiene moneda configurada. Indique currencyCode en price."
      });
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

// ---------------------------------------------------------------------------
// AI Enrichment handlers
// ---------------------------------------------------------------------------

/**
 * POST /api/admin/menu-items/:id/generate-enrichment
 *
 * Genera un borrador de metadatos AI para el producto y lo devuelve al cliente
 * para revisión. No persiste nada en la base de datos.
 */
export async function generateMenuItemEnrichmentHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  try {
    const draft = await generateMenuItemEnrichment(parsedParams.data.id);
    return res.json({ draft });
  } catch (error) {
    if ((error as Error).message === "MENU_ITEM_NOT_FOUND") {
      return res.status(404).json({ error: "Menu item no encontrado" });
    }
    if ((error as Error).message === "ENRICHMENT_INVALID_JSON") {
      return res.status(502).json({ error: "El modelo no devolvió una respuesta válida. Intentá nuevamente." });
    }
    throw error;
  }
}

/**
 * GET /api/admin/menu-items/:id/ai-metadata
 *
 * Devuelve los metadatos AI guardados para un producto, o 404 si aún no fue
 * enriquecido.
 */
export async function getMenuItemAiMetadataHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const metadata = await getMenuItemAiMetadata(parsedParams.data.id);
  if (!metadata) {
    return res.status(404).json({ error: "Este producto aún no tiene metadatos AI generados" });
  }

  return res.json(metadata);
}

const aiMetadataSchema = z.object({
  display_name: z.string().max(24).optional().nullable(),
  short_description: z.string().max(72).optional().nullable(),
  search_keywords: z.array(z.string().min(1)).max(20).optional().nullable(),
  synonyms: z.array(z.string().min(1)).max(10).optional().nullable(),
  category_suggestion: z.string().max(80).optional().nullable(),
  product_tags: z.array(z.string().min(1)).max(20).optional().nullable(),
  modelVersion: z.string().max(40).optional()
});

/**
 * PUT /api/admin/menu-items/:id/ai-metadata
 *
 * Persiste los metadatos AI aprobados (y opcionalmente editados) por el
 * usuario. Regenera el embedding RAG automáticamente tras guardar.
 */
export async function saveMenuItemAiMetadataHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const parsedBody = aiMetadataSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsedBody.error.flatten()
    });
  }

  try {
    const saved = await saveMenuItemAiMetadata(parsedParams.data.id, {
      display_name: parsedBody.data.display_name ?? "",
      short_description: parsedBody.data.short_description ?? "",
      search_keywords: parsedBody.data.search_keywords ?? [],
      synonyms: parsedBody.data.synonyms ?? [],
      category_suggestion: parsedBody.data.category_suggestion ?? "",
      product_tags: parsedBody.data.product_tags ?? [],
      modelVersion: parsedBody.data.modelVersion
    });
    return res.json(saved);
  } catch (error) {
    if ((error as Error).message === "AI_METADATA_SAVE_FAILED") {
      return res.status(500).json({ error: "No se pudo guardar los metadatos AI" });
    }
    throw error;
  }
}
