import type { Request, Response } from "express";
import { z } from "zod";
import {
  listAdminPaymentProofs,
  reviewAdminPaymentProof
} from "../services/adminPaymentProof.service";

const idParamSchema = z.object({
  id: z.string().uuid()
});

const reviewParamsSchema = z.object({
  id: z.string().uuid(),
  proofId: z.string().uuid()
});

const reviewBodySchema = z.object({
  decision: z.enum(["approve", "reject"]),
  note: z.string().trim().min(1).optional()
});

export async function getOrderPaymentProofs(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "id de orden inválido" });
  }

  const proofs = await listAdminPaymentProofs(businessId, parsed.data.id);
  if (proofs === null) {
    return res.status(404).json({ error: "Orden no encontrada" });
  }

  return res.json({ items: proofs });
}

export async function postOrderPaymentProofReview(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  const reviewedBy = req.user?.userId;
  if (!businessId || !reviewedBy) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const paramsParsed = reviewParamsSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: "Parámetros inválidos" });
  }

  const bodyParsed = reviewBodySchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: bodyParsed.error.flatten()
    });
  }

  const result = await reviewAdminPaymentProof({
    businessId,
    orderId: paramsParsed.data.id,
    proofId: paramsParsed.data.proofId,
    decision: bodyParsed.data.decision,
    reviewedBy,
    note: bodyParsed.data.note
  });

  if (result.outcome === "not_found") {
    return res.status(404).json({ error: "Comprobante no encontrado" });
  }

  return res.json(result.proof);
}
