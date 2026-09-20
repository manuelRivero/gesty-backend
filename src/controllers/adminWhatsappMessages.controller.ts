import type { Request, Response } from "express";
import { z } from "zod";
import { listAdminWhatsappMessages, listAdminConversations } from "../services/adminWhatsappMessages.service";
import { ConversationSentiment } from "../types/conversationSentiment";
import { findBusinessMembership } from "../services/conversationInbox.shared";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  conversationId: z.string().uuid().optional(),
  customerPhone: z.string().min(1).optional()
});

const listConversationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  sentiment: z.nativeEnum(ConversationSentiment).optional(),
  customerPhone: z.string().min(1).optional(),
  assignedTo: z.string().min(1).optional(),
  support: z.enum(["pending"]).optional()
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

export async function getWhatsappConversations(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  const userId = req.user?.userId;
  if (!businessId || !userId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsed = listConversationsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsed.error.flatten()
    });
  }

  const q = parsed.data;
  let actorBusinessUserId: string | undefined;
  if (q.assignedTo === "me") {
    const membership = await findBusinessMembership({ businessId, userId });
    if (!membership) {
      return res.status(403).json({ error: "Sin membresía en este negocio" });
    }
    actorBusinessUserId = membership.id;
  }

  const result = await listAdminConversations({
    businessId,
    page: q.page,
    pageSize: q.pageSize,
    sentiment: q.sentiment,
    customerPhone: q.customerPhone,
    assignedTo: q.assignedTo,
    actorBusinessUserId,
    supportPending: q.support === "pending"
  });

  return res.json(result);
}
