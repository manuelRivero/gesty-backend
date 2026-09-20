import type { Request, Response } from "express";
import { z } from "zod";
import {
  assignConversation,
  ConversationAssignmentError,
  takeConversation
} from "../services/conversationAssignment.service";
import { ackConversationSupport, SupportAckError } from "../services/conversationSupportAck.service";
import {
  ConversationNoteError,
  createConversationNote,
  deleteConversationNote,
  listConversationNotes
} from "../services/conversationNotes.service";
import { touchConversationViewer } from "../services/conversationViewers.service";
import { findBusinessMembership } from "../services/conversationInbox.shared";
import { prisma } from "../lib/prisma";

const conversationIdParams = z.object({
  conversationId: z.string().uuid()
});

const postgresUuid = z.string().uuid();

async function resolveActorMembership(
  req: Request,
  res: Response
): Promise<{ businessId: string; businessUserId: string } | null> {
  const businessId = req.user?.businessId;
  const userId = req.user?.userId;
  if (!businessId || !userId) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  const membership = await findBusinessMembership({ businessId, userId });
  if (!membership) {
    res.status(403).json({ error: "Sin membresía en este negocio" });
    return null;
  }
  return { businessId, businessUserId: membership.id };
}

export async function patchWhatsappConversationAssignment(
  req: Request,
  res: Response
) {
  const actor = await resolveActorMembership(req, res);
  if (!actor) return;

  const parsedParams = conversationIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }

  const bodySchema = z.object({
    businessUserId: postgresUuid.nullable()
  });
  const parsedBody = bodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsedBody.error.flatten()
    });
  }

  try {
    const result = await assignConversation({
      businessId: actor.businessId,
      conversationId: parsedParams.data.conversationId,
      businessUserId: parsedBody.data.businessUserId
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof ConversationAssignmentError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    console.error("[AdminWhatsappAssignment] Error:", err);
    return res.status(500).json({ error: "No se pudo actualizar la asignación" });
  }
}

export async function postWhatsappConversationTake(req: Request, res: Response) {
  const actor = await resolveActorMembership(req, res);
  if (!actor) return;

  const parsedParams = conversationIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }

  try {
    const result = await takeConversation({
      businessId: actor.businessId,
      conversationId: parsedParams.data.conversationId,
      actorBusinessUserId: actor.businessUserId
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof ConversationAssignmentError) {
      const status = err.code === "NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    console.error("[AdminWhatsappTake] Error:", err);
    return res.status(500).json({ error: "No se pudo tomar la conversación" });
  }
}

export async function postWhatsappConversationSupportAck(
  req: Request,
  res: Response
) {
  const actor = await resolveActorMembership(req, res);
  if (!actor) return;

  const parsedParams = conversationIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }

  try {
    const result = await ackConversationSupport({
      businessId: actor.businessId,
      conversationId: parsedParams.data.conversationId,
      actorBusinessUserId: actor.businessUserId
    });
    return res.json(result);
  } catch (err) {
    if (err instanceof SupportAckError) {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    console.error("[AdminWhatsappSupportAck] Error:", err);
    return res.status(500).json({ error: "No se pudo acusar el soporte" });
  }
}

export async function getWhatsappConversationNotes(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = conversationIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }

  try {
    const items = await listConversationNotes({
      businessId,
      conversationId: parsedParams.data.conversationId
    });
    return res.json({ items });
  } catch (err) {
    if (err instanceof ConversationNoteError) {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    console.error("[AdminWhatsappNotes] list error:", err);
    return res.status(500).json({ error: "No se pudieron listar las notas" });
  }
}

export async function postWhatsappConversationNote(req: Request, res: Response) {
  const actor = await resolveActorMembership(req, res);
  if (!actor) return;

  const parsedParams = conversationIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }

  const bodySchema = z.object({
    body: z.string().trim().min(1).max(4000)
  });
  const parsedBody = bodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsedBody.error.flatten()
    });
  }

  try {
    const note = await createConversationNote({
      businessId: actor.businessId,
      conversationId: parsedParams.data.conversationId,
      body: parsedBody.data.body,
      actorBusinessUserId: actor.businessUserId
    });
    return res.status(201).json(note);
  } catch (err) {
    if (err instanceof ConversationNoteError) {
      return res.status(404).json({ error: err.message, code: err.code });
    }
    console.error("[AdminWhatsappNotes] create error:", err);
    return res.status(500).json({ error: "No se pudo crear la nota" });
  }
}

export async function deleteWhatsappConversationNote(
  req: Request,
  res: Response
) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const paramsSchema = z.object({
    conversationId: z.string().uuid(),
    noteId: z.string().uuid()
  });
  const parsedParams = paramsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "Parámetros inválidos" });
  }

  try {
    await deleteConversationNote({
      businessId,
      conversationId: parsedParams.data.conversationId,
      noteId: parsedParams.data.noteId
    });
    return res.status(204).send();
  } catch (err) {
    if (err instanceof ConversationNoteError) {
      const status = err.code === "NOTE_NOT_FOUND" ? 404 : 404;
      return res.status(status).json({ error: err.message, code: err.code });
    }
    console.error("[AdminWhatsappNotes] delete error:", err);
    return res.status(500).json({ error: "No se pudo borrar la nota" });
  }
}

export async function postWhatsappConversationViewing(
  req: Request,
  res: Response
) {
  const actor = await resolveActorMembership(req, res);
  if (!actor) return;

  const parsedParams = conversationIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }

  const conversation = await prisma.conversation.findFirst({
    where: {
      id: parsedParams.data.conversationId,
      business_id: actor.businessId
    },
    select: { id: true }
  });
  if (!conversation) {
    return res.status(404).json({ error: "Conversación no encontrada" });
  }

  const membership = await prisma.business_user.findUnique({
    where: { id: actor.businessUserId },
    select: {
      id: true,
      app_user: { select: { name: true } }
    }
  });

  const result = touchConversationViewer({
    businessId: actor.businessId,
    conversationId: parsedParams.data.conversationId,
    businessUserId: actor.businessUserId,
    name: membership?.app_user?.name ?? null
  });

  return res.json(result);
}
