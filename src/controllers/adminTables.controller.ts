import type { Request, Response } from "express";
import { z } from "zod";
import {
  createAdminTable,
  deleteAdminTable,
  getAdminTableById,
  listAdminTables,
  updateAdminTable
} from "../services/adminTables.service";

/** Alineado con UUID en PostgreSQL; Zod `.uuid()` rechaza variantes RFC (p. ej. `...-3333-...`). */
const postgresUuid = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "UUID inválido"
);

const idParamSchema = z.object({
  id: postgresUuid
});

const optionalFloat = z.union([z.coerce.number(), z.null()]).optional();
const optionalString = z.union([z.string(), z.null()]).optional();

const createSchema = z.object({
  environmentId: postgresUuid,
  name: z.string().trim().min(1).max(120),
  capacity: z.coerce.number().int().min(1).max(500),
  isActive: z.boolean().optional(),
  x: optionalFloat,
  y: optionalFloat,
  shape: optionalString,
  width: optionalFloat,
  height: optionalFloat,
  rotation: optionalFloat
});

const updateSchema = z.object({
  environmentId: postgresUuid.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  capacity: z.coerce.number().int().min(1).max(500).optional(),
  isActive: z.boolean().optional(),
  x: optionalFloat,
  y: optionalFloat,
  shape: optionalString,
  width: optionalFloat,
  height: optionalFloat,
  rotation: optionalFloat
});

export async function getTables(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const items = await listAdminTables({ businessId });
  return res.json({ items });
}

export async function getTableById(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await getAdminTableById({
    businessId,
    id: parsedParams.data.id
  });
  if (!row) {
    return res.status(404).json({ error: "Mesa no encontrada" });
  }

  return res.json(row);
}

export async function postTable(req: Request, res: Response) {
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

  const row = await createAdminTable({
    businessId,
    ...parsed.data
  });

  if (row === "ENVIRONMENT_NOT_FOUND") {
    return res.status(400).json({ error: "Ambiente no encontrado en este negocio" });
  }

  return res.status(201).json(row);
}

export async function patchTable(req: Request, res: Response) {
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

  const row = await updateAdminTable({
    businessId,
    id: parsedParams.data.id,
    ...parsedBody.data
  });

  if (row === "ENVIRONMENT_NOT_FOUND") {
    return res.status(400).json({ error: "Ambiente no encontrado en este negocio" });
  }
  if (!row) {
    return res.status(404).json({ error: "Mesa no encontrada" });
  }

  return res.json(row);
}

export async function removeTable(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await deleteAdminTable({
    businessId,
    id: parsedParams.data.id
  });

  if (!row) {
    return res.status(404).json({ error: "Mesa no encontrada" });
  }

  return res.json({ success: true, id: row.id });
}
