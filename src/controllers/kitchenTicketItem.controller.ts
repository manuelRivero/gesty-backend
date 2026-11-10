import type { Request, Response } from "express";
import { z } from "zod";
import { advanceKitchenTicketItemStatus } from "../services/kitchenTicketItem.service";

const postgresUuid = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "UUID inválido"
);

const idParamSchema = z.object({ id: postgresUuid });
const patchStatusSchema = z.object({ status: z.enum(["preparing", "ready"]) });

function requireAuth(req: Request, res: Response): { businessId: string; userId: string } | null {
  const businessId = req.user?.businessId;
  const userId = req.user?.userId;
  if (!businessId || !userId) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  return { businessId, userId };
}

export async function patchKitchenTicketItemStatus(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }
  const parsed = patchStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const result = await advanceKitchenTicketItemStatus({
    businessId: auth.businessId,
    kitchenTicketItemId: parsedParams.data.id,
    toStatus: parsed.data.status,
    userId: auth.userId
  });

  if (!result.ok) {
    const statusByReason: Record<typeof result.reason, number> = {
      NOT_FOUND: 404,
      INVALID_TRANSITION: 409,
      CONCURRENT_UPDATE: 409
    };
    return res
      .status(statusByReason[result.reason])
      .json({ error: result.reason, currentStatus: result.currentStatus });
  }

  return res.json({ id: result.id, status: result.status });
}
