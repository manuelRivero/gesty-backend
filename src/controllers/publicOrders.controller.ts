import type { Request, Response } from "express";
import { z } from "zod";
import {
  createPublicCounterOrder,
  createPublicOrderCheckout,
  getPublicCounterOrder,
  PublicOrderError,
  quotePublicDelivery
} from "../services/publicOrders.service";

const slugParamSchema = z.object({
  slug: z.string().trim().min(1).max(120)
});

const orderParamsSchema = z.object({
  slug: z.string().trim().min(1).max(120),
  orderId: z.string().uuid()
});

const deliveryAddressSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  streetAddress: z.string().trim().min(1).max(255),
  apartment: z.string().trim().max(50).optional().nullable(),
  neighborhood: z.string().trim().max(100).optional().nullable(),
  city: z.string().trim().max(100).optional().nullable(),
  instructions: z.string().trim().max(500).optional().nullable()
});

const createOrderBodySchema = z
  .object({
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
    fulfillmentType: z
      .enum(["TAKE_AWAY", "DELIVERY"])
      .optional()
      .default("TAKE_AWAY"),
    address: deliveryAddressSchema.optional().nullable(),
    paymentMethod: z.enum(["cash", "online"]).optional().default("cash"),
    notes: z.string().trim().max(500).optional().nullable()
  })
  .superRefine((data, ctx) => {
    if (data.fulfillmentType === "DELIVERY" && !data.address) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "address es obligatorio para DELIVERY",
        path: ["address"]
      });
    }
  });

const deliveryQuoteBodySchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  itemsSubtotal: z
    .union([z.string(), z.number()])
    .optional()
    .nullable()
    .transform((v) => {
      if (v == null || v === "") return null;
      const n = typeof v === "number" ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    })
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

export async function quoteStorefrontDelivery(req: Request, res: Response) {
  const parsedParams = slugParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "slug inválido" });
  }

  const parsedBody = deliveryQuoteBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Datos inválidos",
      code: "INVALID_BODY",
      details: parsedBody.error.flatten()
    });
  }

  try {
    const quote = await quotePublicDelivery({
      slugOrId: parsedParams.data.slug,
      latitude: parsedBody.data.latitude,
      longitude: parsedBody.data.longitude,
      itemsSubtotal: parsedBody.data.itemsSubtotal
    });
    return res.json(quote);
  } catch (err) {
    return sendPublicOrderError(res, err);
  }
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
      address: parsedBody.data.address ?? null,
      paymentMethod: parsedBody.data.paymentMethod,
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

export async function createStorefrontOrderCheckout(
  req: Request,
  res: Response
) {
  const parsedParams = orderParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      code: "INVALID_PARAMS"
    });
  }

  try {
    const result = await createPublicOrderCheckout({
      slugOrId: parsedParams.data.slug,
      orderId: parsedParams.data.orderId
    });
    return res.json(result);
  } catch (err) {
    return sendPublicOrderError(res, err);
  }
}
