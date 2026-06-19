import type { Request, Response } from "express";
import { listActiveBotPersonalities } from "../services/botPersonality.service";

export async function getAdminBotPersonalities(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const personalities = await listActiveBotPersonalities();
  return res.json(personalities);
}
