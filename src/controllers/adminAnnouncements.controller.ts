import type { Request, Response } from "express";
import { z } from "zod";
import {
  getAnnouncementForBusiness,
  getReadersByBusiness,
  getUnreadCount,
  listAnnouncementsForBusiness,
  markAnnouncementRead,
} from "../services/announcements.service";
import type { BusinessUserRole } from "../types/auth";

// ---------------------------------------------------------------------------
// Validaciones Zod
// ---------------------------------------------------------------------------

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function listAnnouncementsForBusinessHandler(
  req: Request,
  res: Response
): Promise<void> {
  const user = req.user;
  if (!user?.businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Parámetros inválidos", details: parsed.error.flatten() });
    return;
  }
  const result = await listAnnouncementsForBusiness({
    role: user.role as BusinessUserRole,
    userId: user.userId,
    businessId: user.businessId,
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
  });
  res.json(result);
}

export async function getUnreadCountHandler(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user?.businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const count = await getUnreadCount({
    role: user.role as BusinessUserRole,
    userId: user.userId,
    businessId: user.businessId,
  });
  res.json({ count });
}

export async function getAnnouncementForBusinessHandler(
  req: Request,
  res: Response
): Promise<void> {
  const user = req.user;
  if (!user?.businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const announcement = await getAnnouncementForBusiness({
    id: parsed.data.id,
    role: user.role as BusinessUserRole,
    userId: user.userId,
    businessId: user.businessId,
  });
  if (!announcement) {
    res.status(404).json({ error: "Anuncio no encontrado" });
    return;
  }
  res.json(announcement);
}

export async function markAnnouncementReadHandler(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user?.businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  // Verificar que el anuncio sea accesible para el usuario
  const accessible = await getAnnouncementForBusiness({
    id: parsed.data.id,
    role: user.role as BusinessUserRole,
    userId: user.userId,
    businessId: user.businessId,
  });
  if (!accessible) {
    res.status(404).json({ error: "Anuncio no encontrado" });
    return;
  }
  const result = await markAnnouncementRead({
    announcementId: parsed.data.id,
    userId: user.userId,
    businessId: user.businessId,
  });
  res.json(result);
}

export async function getReadersForBusinessHandler(req: Request, res: Response): Promise<void> {
  const user = req.user;
  if (!user?.businessId) {
    res.status(401).json({ error: "No autenticado" });
    return;
  }
  if (user.role !== "OWNER" && user.role !== "ADMIN") {
    res.status(403).json({ error: "Solo OWNER o ADMIN pueden ver los lectores" });
    return;
  }
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "ID inválido" });
    return;
  }
  const readers = await getReadersByBusiness({
    announcementId: parsed.data.id,
    businessId: user.businessId,
  });
  res.json({ items: readers });
}
