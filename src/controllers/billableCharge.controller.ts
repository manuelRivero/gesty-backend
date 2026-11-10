import type { Request, Response } from "express";
import { z } from "zod";
import { createBillableCharge } from "../services/billableCharge.service";

const postgresUuid = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "UUID inválido"
);

const idParamSchema = z.object({ id: postgresUuid });

const createBillableChargeSchema = z.object({
  lines: z
    .array(
      z.object({
        orderItemId: postgresUuid,
        quantity: z.coerce.number().int().min(1).max(999)
      })
    )
    .min(1)
    .max(100)
});

function requireAuth(req: Request, res: Response): { businessId: string } | null {
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  return { businessId };
}

export async function postCreateBillableCharge(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }
  const parsed = createBillableChargeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const result = await createBillableCharge({
    businessId: auth.businessId,
    tableTabId: parsedParams.data.id,
    lines: parsed.data.lines
  });

  if (!result.ok) {
    const statusByReason: Record<typeof result.reason, number> = {
      TABLE_TAB_NOT_FOUND: 404,
      EMPTY_CHARGE: 400,
      ORDER_ITEM_NOT_IN_TAB: 404,
      QUANTITY_EXCEEDS_REMAINING: 409
    };
    return res
      .status(statusByReason[result.reason])
      .json({ error: result.reason, orderItemId: result.orderItemId });
  }

  return res.status(201).json({ billableChargeId: result.billableChargeId, amount: result.amount });
}
