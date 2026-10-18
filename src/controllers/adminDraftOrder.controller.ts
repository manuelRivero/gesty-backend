import type { Request, Response } from "express";
import { z } from "zod";
import {
  AdminDraftOrderError,
  addAdminDraftOrderItem,
  getAdminDraftOrder,
  removeAdminDraftOrderItem,
  requestAdminDraftOrderConfirmation,
  setAdminDraftOrderFulfillment,
  updateAdminDraftOrderItemQuantity
} from "../services/adminDraftOrder.service";

const conversationIdParams = z.object({
  conversationId: z.string().uuid()
});

const itemParams = conversationIdParams.extend({
  itemId: z.string().uuid()
});

function statusForError(err: AdminDraftOrderError): number {
  switch (err.code) {
    case "NOT_FOUND":
      return 404;
    case "ITEM_NOT_FOUND":
    case "PRODUCT_NOT_FOUND":
      return 404;
    case "EMPTY_CART":
      return 404;
    case "NOT_HUMAN_HANDLED":
    case "INVALID_QUANTITY":
    case "NO_ADDRESS":
    case "OUT_OF_COVERAGE":
    case "PAYMENT_METHOD_NOT_OFFERED":
    case "NO_WHATSAPP_CONFIG":
      return 409;
    default:
      return 400;
  }
}

function resolveBusinessId(req: Request, res: Response): string | null {
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  return businessId;
}

export async function getAdminDraftOrderHandler(req: Request, res: Response) {
  const businessId = resolveBusinessId(req, res);
  if (!businessId) return;

  const parsedParams = conversationIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }

  try {
    const result = await getAdminDraftOrder(businessId, parsedParams.data.conversationId);
    return res.json(result);
  } catch (err) {
    if (err instanceof AdminDraftOrderError) {
      return res.status(statusForError(err)).json({ error: err.message, code: err.code });
    }
    console.error("[AdminDraftOrder] get error:", err);
    return res.status(500).json({ error: "No se pudo obtener el pedido" });
  }
}

const addItemBody = z.object({
  menuItemId: z.string().uuid(),
  quantity: z.number().int().positive().optional(),
  variation: z.string().nullable().optional()
});

export async function postAdminDraftOrderItemHandler(req: Request, res: Response) {
  const businessId = resolveBusinessId(req, res);
  if (!businessId) return;

  const parsedParams = conversationIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }
  const parsedBody = addItemBody.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: "Body inválido", details: parsedBody.error.flatten() });
  }

  try {
    const result = await addAdminDraftOrderItem(
      businessId,
      parsedParams.data.conversationId,
      parsedBody.data
    );
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof AdminDraftOrderError) {
      return res.status(statusForError(err)).json({ error: err.message, code: err.code });
    }
    console.error("[AdminDraftOrder] add error:", err);
    return res.status(500).json({ error: "No se pudo agregar el producto" });
  }
}

const quantityBody = z.object({
  quantity: z.number().int().positive()
});

export async function patchAdminDraftOrderItemHandler(req: Request, res: Response) {
  const businessId = resolveBusinessId(req, res);
  if (!businessId) return;

  const parsedParams = itemParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "Parámetros inválidos" });
  }
  const parsedBody = quantityBody.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: "Body inválido", details: parsedBody.error.flatten() });
  }

  try {
    const result = await updateAdminDraftOrderItemQuantity(
      businessId,
      parsedParams.data.conversationId,
      parsedParams.data.itemId,
      parsedBody.data.quantity
    );
    return res.json(result);
  } catch (err) {
    if (err instanceof AdminDraftOrderError) {
      return res.status(statusForError(err)).json({ error: err.message, code: err.code });
    }
    console.error("[AdminDraftOrder] update quantity error:", err);
    return res.status(500).json({ error: "No se pudo actualizar la cantidad" });
  }
}

export async function deleteAdminDraftOrderItemHandler(req: Request, res: Response) {
  const businessId = resolveBusinessId(req, res);
  if (!businessId) return;

  const parsedParams = itemParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "Parámetros inválidos" });
  }

  try {
    const result = await removeAdminDraftOrderItem(
      businessId,
      parsedParams.data.conversationId,
      parsedParams.data.itemId
    );
    return res.json(result);
  } catch (err) {
    if (err instanceof AdminDraftOrderError) {
      return res.status(statusForError(err)).json({ error: err.message, code: err.code });
    }
    console.error("[AdminDraftOrder] remove error:", err);
    return res.status(500).json({ error: "No se pudo quitar el ítem" });
  }
}

const fulfillmentBody = z.object({
  fulfillmentType: z.enum(["TAKE_AWAY", "DELIVERY"])
});

export async function patchAdminDraftOrderFulfillmentHandler(req: Request, res: Response) {
  const businessId = resolveBusinessId(req, res);
  if (!businessId) return;

  const parsedParams = conversationIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }
  const parsedBody = fulfillmentBody.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({ error: "Body inválido", details: parsedBody.error.flatten() });
  }

  try {
    const result = await setAdminDraftOrderFulfillment(
      businessId,
      parsedParams.data.conversationId,
      parsedBody.data.fulfillmentType
    );
    return res.json(result);
  } catch (err) {
    if (err instanceof AdminDraftOrderError) {
      return res.status(statusForError(err)).json({ error: err.message, code: err.code });
    }
    console.error("[AdminDraftOrder] set fulfillment error:", err);
    return res.status(500).json({ error: "No se pudo actualizar la modalidad" });
  }
}

const requestConfirmationBody = z.object({
  paymentMethod: z.string()
});

export async function postAdminDraftOrderRequestConfirmationHandler(req: Request, res: Response) {
  const businessId = resolveBusinessId(req, res);
  if (!businessId) return;

  const parsedParams = conversationIdParams.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "conversationId inválido" });
  }
  const parsedBody = requestConfirmationBody.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    return res.status(400).json({ error: "Body inválido", details: parsedBody.error.flatten() });
  }

  try {
    const result = await requestAdminDraftOrderConfirmation(
      businessId,
      parsedParams.data.conversationId,
      parsedBody.data
    );
    return res.status(201).json(result);
  } catch (err) {
    if (err instanceof AdminDraftOrderError) {
      return res.status(statusForError(err)).json({ error: err.message, code: err.code });
    }
    console.error("[AdminDraftOrder] request confirmation error:", err);
    return res.status(500).json({ error: "No se pudo enviar la confirmación" });
  }
}
