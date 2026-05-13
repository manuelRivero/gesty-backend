import type { Request, Response } from "express";
import { z } from "zod";
import { listFeaturedMenuItems, getPublicBusinessInfo } from "../services/publicMenu.service";

const featuredQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

const businessIdParamSchema = z.object({
  businessId: z.string().uuid()
});

export async function getFeaturedMenuItems(req: Request, res: Response) {
  const parsedParams = businessIdParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "businessId inválido" });
  }

  const parsedQuery = featuredQuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsedQuery.error.flatten()
    });
  }

  const items = await listFeaturedMenuItems({
    businessId: parsedParams.data.businessId,
    limit: parsedQuery.data.limit
  });

  return res.json({ items });
}

export async function getBusinessInfo(req: Request, res: Response) {
  const parsedParams = businessIdParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "businessId inválido" });
  }

  const data = await getPublicBusinessInfo({
    businessId: parsedParams.data.businessId
  });

  if (!data) {
    return res.status(404).json({ error: "Business no encontrado" });
  }

  return res.json(data);
}
