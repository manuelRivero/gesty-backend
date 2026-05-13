import type { Request, Response } from "express";
import { z } from "zod";
import {
  getBusinessWithSubscriptionForSuperAdmin,
  listBusinessesForSuperAdmin
} from "../services/superAdminBusinesses.service";

const listQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  q: z.string().optional()
});

const idParamSchema = z.object({
  id: z.string().uuid()
});

export async function getSuperAdminBusinessesList(
  req: Request,
  res: Response
): Promise<void> {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "Parámetros inválidos",
      details: parsed.error.flatten()
    });
    return;
  }
  const { offset, limit, q } = parsed.data;
  const result = await listBusinessesForSuperAdmin({
    skip: offset,
    take: limit,
    q
  });
  res.json(result);
}

export async function getSuperAdminBusinessById(
  req: Request,
  res: Response
): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "id inválido" });
    return;
  }
  const row = await getBusinessWithSubscriptionForSuperAdmin(parsed.data.id);
  if (!row) {
    res.status(404).json({ error: "Negocio no encontrado" });
    return;
  }
  res.json(row);
}
