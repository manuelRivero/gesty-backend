import type { Request, Response } from "express";
import { z } from "zod";
import {
  getConversationBotStatus,
  setConversationBotStatus
} from "../services/adminWhatsappBotControl.service";

const paramsSchema = z.object({
  conversationId: z.string().uuid()
});

const patchSchema = z.object({
  enabled: z.boolean()
});

export async function getWhatsappConversationBotStatus(
  req: Request,
  res: Response
) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }

  const result = await getConversationBotStatus(
    businessId,
    parsedParams.data.conversationId
  );

  if (!result) {
    return res.status(404).json({ error: "Conversación no encontrada" });
  }

  return res.json(result);
}

export async function patchWhatsappConversationBotStatus(
  req: Request,
  res: Response
) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }

  const parsedBody = patchSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsedBody.error.flatten()
    });
  }

  const result = await setConversationBotStatus(
    businessId,
    parsedParams.data.conversationId,
    parsedBody.data.enabled
  );

  if (!result) {
    return res.status(404).json({ error: "Conversación no encontrada" });
  }

  return res.json(result);
}
