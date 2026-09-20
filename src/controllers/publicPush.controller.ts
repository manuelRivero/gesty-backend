import type { Request, Response } from "express";
import { z } from "zod";
import {
  deleteStorefrontPushSubscription,
  getVapidPublicKey,
  isStorefrontPushConfigured,
  StorefrontPushError,
  upsertStorefrontPushSubscription
} from "../services/storefrontOrderPush.service";

const orderParamsSchema = z.object({
  slug: z.string().trim().min(1).max(120),
  orderId: z.string().uuid()
});

const subscriptionBodySchema = z.object({
  subscription: z.unknown()
});

const deleteBodySchema = z.object({
  endpoint: z.string().trim().min(1).max(2048)
});

function sendError(res: Response, err: unknown) {
  if (err instanceof StorefrontPushError) {
    return res.status(err.httpStatus).json({
      error: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {})
    });
  }
  throw err;
}

/**
 * GET /api/public/push/vapid-public-key
 */
export async function getPublicVapidKey(_req: Request, res: Response) {
  if (!isStorefrontPushConfigured()) {
    return res.status(503).json({
      error: "Web Push no configurado",
      code: "PUSH_NOT_CONFIGURED"
    });
  }
  return res.json({ publicKey: getVapidPublicKey() });
}

/**
 * POST /api/public/businesses/:slug/orders/:orderId/push-subscription
 */
export async function registerStorefrontPushSubscription(
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

  const parsedBody = subscriptionBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "subscription inválida",
      code: "INVALID_SUBSCRIPTION",
      details: parsedBody.error.flatten()
    });
  }

  try {
    await upsertStorefrontPushSubscription({
      slugOrId: parsedParams.data.slug,
      orderId: parsedParams.data.orderId,
      subscription: parsedBody.data.subscription,
      userAgent:
        typeof req.headers["user-agent"] === "string"
          ? req.headers["user-agent"]
          : null
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
}

/**
 * DELETE /api/public/businesses/:slug/orders/:orderId/push-subscription
 */
export async function unregisterStorefrontPushSubscription(
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

  const parsedBody = deleteBodySchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "endpoint inválido",
      code: "INVALID_SUBSCRIPTION",
      details: parsedBody.error.flatten()
    });
  }

  try {
    await deleteStorefrontPushSubscription({
      slugOrId: parsedParams.data.slug,
      orderId: parsedParams.data.orderId,
      endpoint: parsedBody.data.endpoint
    });
    return res.status(204).send();
  } catch (err) {
    return sendError(res, err);
  }
}
