import type { Request, Response } from "express";
import { z } from "zod";
import {
  createAdminEnvironment,
  deleteAdminEnvironment,
  getAdminEnvironmentById,
  listAdminEnvironments,
  updateAdminEnvironment
} from "../services/adminEnvironments.service";

/** Alineado con UUID en PostgreSQL; Zod `.uuid()` rechaza variantes RFC (p. ej. `...-3333-...`). */
const postgresUuid = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "UUID inválido"
);

const idParamSchema = z.object({
  id: postgresUuid
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().optional(),
  isOutdoor: z.boolean().optional(),
  isActive: z.boolean().optional()
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  isOutdoor: z.boolean().optional(),
  isActive: z.boolean().optional()
});

export async function getEnvironments(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const items = await listAdminEnvironments({ businessId });
  return res.json({ items });
}

export async function getEnvironmentById(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await getAdminEnvironmentById({
    businessId,
    id: parsedParams.data.id
  });
  if (!row) {
    return res.status(404).json({ error: "Ambiente no encontrado" });
  }

  return res.json(row);
}

export async function postEnvironment(req: Request, res: Response) {
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

  const row = await createAdminEnvironment({
    businessId,
    ...parsed.data
  });

  return res.status(201).json(row);
}

export async function patchEnvironment(req: Request, res: Response) {
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

  const row = await updateAdminEnvironment({
    businessId,
    id: parsedParams.data.id,
    ...parsedBody.data
  });

  if (!row) {
    return res.status(404).json({ error: "Ambiente no encontrado" });
  }

  return res.json(row);
}

export async function removeEnvironment(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await deleteAdminEnvironment({
    businessId,
    id: parsedParams.data.id
  });

  if (!row) {
    return res.status(404).json({ error: "Ambiente no encontrado" });
  }

  return res.json({ success: true, id: row.id });
}
