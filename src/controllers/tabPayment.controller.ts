import type { Request, Response } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { recordTabPayment } from "../services/tabPayment.service";
import { getBusinessUserIdForActor } from "../services/businessUserContext.service";

const postgresUuid = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "UUID inválido"
);

const idParamSchema = z.object({ id: postgresUuid });

/** Acepta number o string decimal — nunca float binario para dinero más allá de este borde. */
const decimalAmount = z
  .union([z.number(), z.string()])
  .transform((v) => new Prisma.Decimal(v))
  .refine((d) => d.gt(0), "El monto debe ser mayor a 0");

const recordPaymentSchema = z.object({
  amountTendered: decimalAmount,
  // Asignación explícita del cajero — opcional, FIFO por defecto si se omite (§4.D).
  allocations: z
    .array(
      z.object({
        orderId: postgresUuid,
        amount: decimalAmount
      })
    )
    .min(1)
    .optional()
});

function requireAuth(req: Request, res: Response): { businessId: string; userId: string } | null {
  const businessId = req.user?.businessId;
  const userId = req.user?.userId;
  if (!businessId || !userId) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  return { businessId, userId };
}

/** `req.user.userId` es `AppUser.id`; `tab_payment.created_by_user_id` referencia `business_user(id)`. */
async function resolveActorBusinessUserId(
  req: Request,
  res: Response,
  auth: { businessId: string; userId: string }
): Promise<string | null> {
  const businessUserId = await getBusinessUserIdForActor({
    userId: auth.userId,
    businessId: auth.businessId
  });
  if (!businessUserId) {
    res.status(403).json({ error: "ACTOR_WITHOUT_MEMBERSHIP" });
    return null;
  }
  return businessUserId;
}

export async function postRecordTabPayment(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }
  const parsed = recordPaymentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const businessUserId = await resolveActorBusinessUserId(req, res, auth);
  if (!businessUserId) return;

  const result = await recordTabPayment({
    businessId: auth.businessId,
    tableTabId: parsedParams.data.id,
    amountTendered: parsed.data.amountTendered,
    allocations: parsed.data.allocations?.map((a) => ({ orderId: a.orderId, amount: a.amount })),
    userId: businessUserId
  });

  if (!result.ok) {
    const statusByReason: Record<typeof result.reason, number> = {
      TABLE_TAB_NOT_FOUND: 404,
      NOTHING_TO_APPLY: 400,
      ALLOCATION_ORDER_NOT_IN_TAB: 400,
      ALLOCATION_EXCEEDS_ORDER_DUE: 409,
      ALLOCATIONS_EXCEED_AMOUNT_TENDERED: 400
    };
    return res.status(statusByReason[result.reason]).json({ error: result.reason, orderId: result.orderId });
  }

  return res.status(201).json({
    tabPaymentId: result.tabPaymentId,
    amountTendered: result.amountTendered,
    amountApplied: result.amountApplied,
    change: result.change,
    allocations: result.allocations
  });
}
