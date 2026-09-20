import type { Request, Response } from "express";
import { z } from "zod";
import {
  CannedReplyError,
  createCannedReply,
  deleteCannedReply,
  listCannedReplies,
  updateCannedReply
} from "../services/cannedReplies.service";

const idParams = z.object({ id: z.string().uuid() });

export async function getCannedReplies(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const querySchema = z.object({
    includeInactive: z
      .enum(["true", "false", "1", "0"])
      .optional()
      .transform((v) => v === "true" || v === "1")
  });
  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsed.error.flatten()
    });
  }

  const items = await listCannedReplies({
    businessId,
    includeInactive: parsed.data.includeInactive
  });
  return res.json({ items });
}

export async function postCannedReply(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const bodySchema = z.object({
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(4096),
    position: z.number().int().optional()
  });
  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsed.error.flatten()
    });
  }

  const item = await createCannedReply({
    businessId,
    title: parsed.data.title,
    body: parsed.data.body,
    position: parsed.data.position
  });
  return res.status(201).json(item);
}

export async function patchCannedReply(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const bodySchema = z
    .object({
      title: z.string().trim().min(1).max(120).optional(),
      body: z.string().trim().min(1).max(4096).optional(),
      position: z.number().int().optional(),
      isActive: z.boolean().optional()
    })
    .refine(
      (v) =>
        v.title !== undefined ||
        v.body !== undefined ||
        v.position !== undefined ||
        v.isActive !== undefined,
      { message: "Indicá al menos un campo" }
    );

  const parsedBody = bodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsedBody.error.flatten()
    });
  }

  try {
    const item = await updateCannedReply({
      businessId,
      id: parsedParams.data.id,
      ...parsedBody.data
    });
    return res.json(item);
  } catch (err) {
    if (err instanceof CannedReplyError) {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    console.error("[CannedReplies] patch error:", err);
    return res.status(500).json({ error: "No se pudo actualizar" });
  }
}

export async function deleteCannedReplyHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  try {
    await deleteCannedReply({
      businessId,
      id: parsedParams.data.id
    });
    return res.status(204).send();
  } catch (err) {
    if (err instanceof CannedReplyError) {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    console.error("[CannedReplies] delete error:", err);
    return res.status(500).json({ error: "No se pudo borrar" });
  }
}
