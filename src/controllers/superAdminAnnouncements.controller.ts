import type { Request, Response } from "express";
import { z } from "zod";
import {
  createAnnouncement,
  getAnnouncementById,
  listAnnouncementsSuperAdmin,
  softDeleteAnnouncement,
  updateAnnouncement,
} from "../services/announcements.service";
import {
  MediaValidationError,
  removeAnnouncementMedia,
  uploadAnnouncementMedia,
} from "../services/announcementMedia.service";
import { ImageValidationError } from "../services/imageOptimization.service";

// ---------------------------------------------------------------------------
// Validaciones Zod
// ---------------------------------------------------------------------------

const VALID_TARGET_ROLES = ["OWNER", "ADMIN", "STAFF", "DELIVERY"] as const;

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const createSchema = z.object({
  title: z.string().trim().min(1).max(255),
  bodyHtml: z.string().trim().min(1),
  targetRoles: z
    .array(z.enum(VALID_TARGET_ROLES))
    .min(1, "Se requiere al menos un rol destino"),
  publishedAt: z.coerce.date(),
  expiresAt: z.coerce.date().nullable().optional(),
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  bodyHtml: z.string().trim().min(1).optional(),
  targetRoles: z.array(z.enum(VALID_TARGET_ROLES)).min(1).optional(),
  publishedAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  isActive: z.boolean().optional(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  active: z.enum(["true", "false"]).optional().transform((v) =>
    v === undefined ? undefined : v === "true"
  ),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function listAnnouncementsHandler(req: Request, res: Response): Promise<void> {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Parámetros inválidos", details: parsed.error.flatten() });
    return;
  }
  const result = await listAnnouncementsSuperAdmin({
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    active: parsed.data.active,
  });
  res.json(result);
}

export async function getAnnouncementHandler(req: Request, res: Response): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const announcement = await getAnnouncementById(parsed.data.id);
  if (!announcement) {
    res.status(404).json({ error: "Anuncio no encontrado" });
    return;
  }
  res.json(announcement);
}

export async function createAnnouncementHandler(req: Request, res: Response): Promise<void> {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Datos inválidos", details: parsed.error.flatten() });
    return;
  }
  const { expiresAt, publishedAt } = parsed.data;
  if (expiresAt && expiresAt <= publishedAt) {
    res.status(400).json({ error: "expiresAt debe ser posterior a publishedAt" });
    return;
  }
  const userId = req.user?.userId;
  if (!userId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const announcement = await createAnnouncement({
    ...parsed.data,
    expiresAt: expiresAt ?? null,
    createdBy: userId,
  });
  res.status(201).json(announcement);
}

export async function updateAnnouncementHandler(req: Request, res: Response): Promise<void> {
  const paramParsed = idParamSchema.safeParse(req.params);
  if (!paramParsed.success) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const bodyParsed = updateSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    res.status(400).json({ error: "Datos inválidos", details: bodyParsed.error.flatten() });
    return;
  }
  const existing = await getAnnouncementById(paramParsed.data.id);
  if (!existing) {
    res.status(404).json({ error: "Anuncio no encontrado" });
    return;
  }
  const { expiresAt, publishedAt } = bodyParsed.data;
  const resolvedPublishedAt = publishedAt ?? existing.publishedAt;
  if (expiresAt && expiresAt <= resolvedPublishedAt) {
    res.status(400).json({ error: "expiresAt debe ser posterior a publishedAt" });
    return;
  }
  const updated = await updateAnnouncement({
    id: paramParsed.data.id,
    ...bodyParsed.data,
  });
  res.json(updated);
}

export async function deleteAnnouncementHandler(req: Request, res: Response): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const existing = await getAnnouncementById(parsed.data.id);
  if (!existing) {
    res.status(404).json({ error: "Anuncio no encontrado" });
    return;
  }
  // Soft delete + limpiar media R2 best-effort
  await softDeleteAnnouncement(parsed.data.id);
  if (existing.media?.key) {
    await removeAnnouncementMedia(parsed.data.id).catch(() => {});
  }
  res.status(204).send();
}

export async function uploadAnnouncementMediaHandler(req: Request, res: Response): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "Se requiere el campo multipart 'media'" });
    return;
  }
  try {
    const result = await uploadAnnouncementMedia({
      announcementId: parsed.data.id,
      buffer: req.file.buffer,
      declaredMime: req.file.mimetype,
    });
    res.json(result);
  } catch (err) {
    if (err instanceof MediaValidationError || err instanceof ImageValidationError) {
      res.status(400).json({ error: err.message });
      return;
    }
    if ((err as Error).message === "ANNOUNCEMENT_NOT_FOUND") {
      res.status(404).json({ error: "Anuncio no encontrado" });
      return;
    }
    throw err;
  }
}

export async function deleteAnnouncementMediaHandler(req: Request, res: Response): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  try {
    await removeAnnouncementMedia(parsed.data.id);
    res.status(204).send();
  } catch (err) {
    if ((err as Error).message === "ANNOUNCEMENT_NOT_FOUND") {
      res.status(404).json({ error: "Anuncio no encontrado" });
      return;
    }
    throw err;
  }
}
