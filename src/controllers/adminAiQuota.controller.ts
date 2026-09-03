import type { Request, Response } from "express";
import { getBusinessAiQuota } from "../services/subscription/businessAiQuota.service";

export async function getAdminAiQuota(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const quota = await getBusinessAiQuota(businessId);
  if (!quota) {
    return res.status(404).json({ error: "Negocio no encontrado" });
  }

  return res.json(quota);
}
