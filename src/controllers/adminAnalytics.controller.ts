import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  getClientRanking,
  getOrderVolume,
  getTopDishes,
} from "../services/adminAnalytics.service";

// ─── Shared helpers ───────────────────────────────────────────────────────────

const basePeriodSchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato inválido para 'from', usa YYYY-MM-DD"),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Formato inválido para 'to', usa YYYY-MM-DD"),
  tz: z.string().min(1).optional(),
});

async function resolveBusinessTz(businessId: string, tz?: string): Promise<string> {
  if (tz) return tz;
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { timezone: true },
  });
  return business?.timezone ?? "UTC";
}

function handleAnalyticsError(e: unknown, res: Response): Response {
  const msg = e instanceof Error ? e.message : String(e);
  if (/time.?zone/i.test(msg)) {
    return res.status(400).json({ error: "Timezone inválida" });
  }
  throw e;
}

// ─── GET /admin/analytics/order-volume ───────────────────────────────────────

export async function getOrderVolumeHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(401).json({ error: "No autenticado" });

  const parsed = basePeriodSchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsed.error.flatten(),
    });
  }

  const { from, to } = parsed.data;
  if (from > to) {
    return res.status(400).json({ error: "Rango inválido: 'from' debe ser ≤ 'to'" });
  }

  try {
    const tz = await resolveBusinessTz(businessId, parsed.data.tz);
    const result = await getOrderVolume({ businessId, from, to, tz });
    return res.json(result);
  } catch (e) {
    return handleAnalyticsError(e, res);
  }
}

// ─── GET /admin/analytics/client-ranking ─────────────────────────────────────

export async function getClientRankingHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(401).json({ error: "No autenticado" });

  const schema = basePeriodSchema.extend({
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsed.error.flatten(),
    });
  }

  const { from, to, limit } = parsed.data;
  if (from > to) {
    return res.status(400).json({ error: "Rango inválido: 'from' debe ser ≤ 'to'" });
  }

  try {
    const tz = await resolveBusinessTz(businessId, parsed.data.tz);
    const result = await getClientRanking({ businessId, from, to, tz, limit });
    return res.json(result);
  } catch (e) {
    return handleAnalyticsError(e, res);
  }
}

// ─── GET /admin/analytics/top-dishes ─────────────────────────────────────────

export async function getTopDishesHandler(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) return res.status(401).json({ error: "No autenticado" });

  const schema = basePeriodSchema.extend({
    limit: z.coerce.number().int().min(1).max(50).optional().default(10),
  });

  const parsed = schema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsed.error.flatten(),
    });
  }

  const { from, to, limit } = parsed.data;
  if (from > to) {
    return res.status(400).json({ error: "Rango inválido: 'from' debe ser ≤ 'to'" });
  }

  try {
    const tz = await resolveBusinessTz(businessId, parsed.data.tz);
    const result = await getTopDishes({ businessId, from, to, tz, limit });
    return res.json(result);
  } catch (e) {
    return handleAnalyticsError(e, res);
  }
}
