import type { Request, Response } from "express";
import { z } from "zod";
import { sendAdminWhatsappReply } from "../services/adminWhatsappReply.service";

const paramsSchema = z.object({
  conversationId: z.string().uuid()
});

const bodySchema = z.object({
  message: z.string().trim().min(1).max(4096),
  /** Si true, no marca la conversación como modo humano (p. ej. aviso al volver el bot). */
  skipHumanTakeover: z.boolean().optional()
});

export async function postAdminWhatsappReply(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  const adminUserId = req.user?.userId;
  if (!businessId || !adminUserId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }

  const parsedBody = bodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsedBody.error.flatten()
    });
  }

  try {
    const result = await sendAdminWhatsappReply({
      businessId,
      conversationId: parsedParams.data.conversationId,
      message: parsedBody.data.message,
      adminUserId,
      skipHumanTakeover: parsedBody.data.skipHumanTakeover === true
    });

    if (!result.ok) {
      if (result.reason === "NOT_FOUND") {
        return res.status(404).json({ error: "Conversación no encontrada" });
      }
      if (result.reason === "BUSINESS_WITHOUT_WHATSAPP_PHONE_ID") {
        return res.status(400).json({
          error: "Negocio sin whatsapp_phone_id configurado"
        });
      }
    }

    return res.status(201).json({ success: true });
  } catch (error) {
    console.error("[AdminWhatsappReply] Error enviando respuesta manual:", error);
    return res.status(500).json({ error: "No se pudo enviar el mensaje" });
  }
}
