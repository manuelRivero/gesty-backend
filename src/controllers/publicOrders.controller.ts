import type { Request, Response } from "express";
import { z } from "zod";
import {
  createPublicCounterOrder,
  getPublicCounterOrder,
  PublicOrderError
} from "../services/publicOrders.service";

const slugParamSchema = z.object({
  slug: z.string().trim().min(1).max(120)
});

const orderParamsSchema = z.object({
  slug: z.string().trim().min(1).max(120),
  orderId: z.string().uuid()
});

const createOrderBodySchema = z.object({
  customer: z.object({
    name: z.string().trim().min(1).max(120).optional().nullable(),
    phone: z.string().trim().min(8).max(32)
  }),
  items: z
    .array(
      z.object({
        menuItemId: z.string().uuid(),
        quantity: z.coerce.number().int().min(1).max(99),
        variation: z.string().trim().min(1).max(120).optional().nullable(),
        notes: z.string().trim().max(500).optional().nullable()
      })
    )
    .min(1)
    .max(50),
  fulfillmentType: z.literal("TAKE_AWAY").optional().default("TAKE_AWAY"),
  /** Cobro siempre manual en mostrador; se ignora si el client manda otra cosa. */
  paymentMethod: z.literal("cash").optional().default("cash"),
  notes: z.string().trim().max(500).optional().nullable()
});

function sendPublicOrderError(res: Response, err: unknown) {
  if (err instanceof PublicOrderError) {
    return res.status(err.httpStatus).json({
      error: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {})
    });
  }
  throw err;
}

export async function createStorefrontOrder(req: Request, res: Response) {
  const parsedParams = slugParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "slug inválido" });
  }

  const parsedBody = createOrderBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Datos inválidos",
      code: "INVALID_BODY",
      details: parsedBody.error.flatten()
    });
  }

  try {
    const order = await createPublicCounterOrder({
      slugOrId: parsedParams.data.slug,
      customer: {
        name: parsedBody.data.customer.name,
        phone: parsedBody.data.customer.phone
      },
      items: parsedBody.data.items.map((item) => ({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        variation: item.variation,
        notes: item.notes
      })),
      fulfillmentType: parsedBody.data.fulfillmentType,
      notes: parsedBody.data.notes
    });

    return res.status(201).json(order);
  } catch (err) {
    return sendPublicOrderError(res, err);
  }
}

export async function getStorefrontOrder(req: Request, res: Response) {
  const parsedParams = orderParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      code: "INVALID_PARAMS"
    });
  }

  try {
    const order = await getPublicCounterOrder({
      slugOrId: parsedParams.data.slug,
      orderId: parsedParams.data.orderId
    });
    return res.json(order);
  } catch (err) {
    return sendPublicOrderError(res, err);
  }
}
