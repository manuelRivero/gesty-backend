import type { Request, Response } from "express";
import { z } from "zod";
import { listAdminWhatsappMessages } from "../services/adminWhatsappMessages.service";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  conversationId: z.string().uuid().optional(),
  customerPhone: z.string().min(1).optional()
});

export async function getWhatsappMessages(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsed.error.flatten()
    });
  }

  const q = parsed.data;
  const result = await listAdminWhatsappMessages({
    businessId,
    page: q.page,
    pageSize: q.pageSize,
    conversationId: q.conversationId,
    customerPhone: q.customerPhone
  });

  return res.json(result);
}
