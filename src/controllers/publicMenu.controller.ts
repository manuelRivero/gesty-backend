import type { Request, Response } from "express";
import { z } from "zod";
import {
  getPublicMenuItemById,
  listFeaturedMenuItems
} from "../services/publicMenu.service";
import {
  getPublicStorefrontFulfillment,
  getPublicStorefrontHours,
  getPublicStorefrontMenu,
  getPublicStorefrontPaymentMethods,
  getPublicStorefrontProfile,
  listPublicMenuCategories,
  listPublicMenuItems
} from "../services/publicStorefront.service";

const LOCAL_UNAVAILABLE = "local no disponible";

const featuredQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

/** Slug preferido; UUID aceptado por compat con deep links viejos. */
const slugParamSchema = z.object({
  slug: z.string().trim().min(1).max(120)
});

const menuItemParamsSchema = z.object({
  slug: z.string().trim().min(1).max(120),
  itemId: z.string().uuid()
});

const menuItemsQuerySchema = z.object({
  categoryId: z.string().uuid().optional(),
  availableOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? true : v === "true"))
});

const menuQuerySchema = z.object({
  availableOnly: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? true : v === "true"))
});

export async function getFeaturedMenuItems(req: Request, res: Response) {
  const parsedParams = slugParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "slug inválido" });
  }

  const parsedQuery = featuredQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsedQuery.error.flatten()
    });
  }

  const items = await listFeaturedMenuItems({
    businessId: parsedParams.data.slug,
    limit: parsedQuery.data.limit
  });

  return res.json({ items });
}

export async function getMenuItemById(req: Request, res: Response) {
  const parsedParams = menuItemParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "Parámetros inválidos" });
  }

  const item = await getPublicMenuItemById({
    businessId: parsedParams.data.slug,
    itemId: parsedParams.data.itemId
  });

  if (!item) {
    return res.status(404).json({ error: "Producto no encontrado" });
  }

  return res.json(item);
}

export async function getBusinessInfo(req: Request, res: Response) {
  const parsedParams = slugParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "slug inválido" });
  }

  const data = await getPublicStorefrontProfile(parsedParams.data.slug);

  if (!data) {
    return res.status(404).json({ error: LOCAL_UNAVAILABLE });
  }

  return res.json(data);
}

export async function getStorefrontMenu(req: Request, res: Response) {
  const parsedParams = slugParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "slug inválido" });
  }

  const parsedQuery = menuQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsedQuery.error.flatten()
    });
  }

  const data = await getPublicStorefrontMenu({
    slugOrId: parsedParams.data.slug,
    availableOnly: parsedQuery.data.availableOnly
  });

  if (!data) {
    return res.status(404).json({ error: LOCAL_UNAVAILABLE });
  }

  return res.json(data);
}

export async function getStorefrontMenuCategories(req: Request, res: Response) {
  const parsedParams = slugParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "slug inválido" });
  }

  const data = await listPublicMenuCategories(parsedParams.data.slug);
  if (!data) {
    return res.status(404).json({ error: LOCAL_UNAVAILABLE });
  }

  return res.json(data);
}

export async function getStorefrontMenuItems(req: Request, res: Response) {
  const parsedParams = slugParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "slug inválido" });
  }

  const parsedQuery = menuItemsQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsedQuery.error.flatten()
    });
  }

  const data = await listPublicMenuItems({
    slugOrId: parsedParams.data.slug,
    categoryId: parsedQuery.data.categoryId,
    availableOnly: parsedQuery.data.availableOnly
  });

  if (!data) {
    return res.status(404).json({ error: LOCAL_UNAVAILABLE });
  }

  return res.json(data);
}

export async function getStorefrontHours(req: Request, res: Response) {
  const parsedParams = slugParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "slug inválido" });
  }

  const data = await getPublicStorefrontHours(parsedParams.data.slug);
  if (!data) {
    return res.status(404).json({ error: LOCAL_UNAVAILABLE });
  }

  return res.json(data);
}

export async function getStorefrontFulfillment(req: Request, res: Response) {
  const parsedParams = slugParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "slug inválido" });
  }

  const data = await getPublicStorefrontFulfillment(parsedParams.data.slug);
  if (!data) {
    return res.status(404).json({ error: LOCAL_UNAVAILABLE });
  }

  return res.json(data);
}

export async function getStorefrontPaymentMethods(req: Request, res: Response) {
  const parsedParams = slugParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "slug inválido" });
  }

  const data = await getPublicStorefrontPaymentMethods(parsedParams.data.slug);
  if (!data) {
    return res.status(404).json({ error: LOCAL_UNAVAILABLE });
  }

  return res.json(data);
}
