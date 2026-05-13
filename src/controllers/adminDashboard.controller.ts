import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { getAdminDashboardSummary } from "../services/adminDashboard.service";

const querySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  tz: z.string().min(1).optional()
});

export async function getDashboardSummary(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsed = querySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsed.error.flatten()
    });
  }

  if (parsed.data.from > parsed.data.to) {
    return res.status(400).json({ error: "Rango inválido: from debe ser <= to" });
  }

  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: { timezone: true }
  });
  const tz = parsed.data.tz ?? business?.timezone ?? "America/Mexico_City";

  try {
    const result = await getAdminDashboardSummary({
      businessId,
      from: parsed.data.from,
      to: parsed.data.to,
      tz
    });
    return res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("time zone")) {
      return res.status(400).json({ error: "Timezone inválida" });
    }
    throw e;
  }
}
