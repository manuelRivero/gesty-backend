import { OrderPaymentStatus, OrderStatus } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { isAdminPatchableOrderStatus } from "../constants/orderWorkflow";
import {
  getAdminOrderById,
  listAdminOrders,
  updateAdminOrderDeliveryStatus,
  updateAdminOrderPaymentStatus
} from "../services/adminOrders.service";
import { getBusinessConfig } from "../services/businessConfig.service";
import {
  EXTERNAL_DELIVERY_MANAGED_ERROR,
  isOwnDeliveryBlocked
} from "../services/externalDeliveryGuard.service";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  orderId: z.string().uuid().optional(),
  dateFrom: z.string().min(1).optional(),
  dateTo: z.string().min(1).optional(),
  customerPhone: z.string().min(1).optional()
});

async function rejectIfOwnDeliveryBlocked(
  req: Request,
  res: Response,
  businessId: string
): Promise<boolean> {
  if (req.user?.role !== "DELIVERY") return false;
  const config = await getBusinessConfig(businessId);
  if (
    !isOwnDeliveryBlocked({
      role: req.user?.role,
      externalDeliveryEnabled: config.external_delivery_enabled
    })
  ) {
    return false;
  }
  res.status(409).json({ error: EXTERNAL_DELIVERY_MANAGED_ERROR });
  return true;
}

export async function getOrders(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  // El rol DELIVERY usa este endpoint para listar los pedidos que debe entregar.
  // Con delivery externo activo, ningún pedido es gestionado por el rider propio.
  if (req.user?.role === "DELIVERY") {
    const config = await getBusinessConfig(businessId);
    if (
      isOwnDeliveryBlocked({
        role: req.user.role,
        externalDeliveryEnabled: config.external_delivery_enabled
      })
    ) {
      return res.json({
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totalPages: 0,
        externalDeliveryEnabled: true
      });
    }
  }

  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Parámetros inválidos",
      details: parsed.error.flatten()
    });
  }

  const q = parsed.data;
  try {
    const result = await listAdminOrders({
      businessId,
      page: q.page,
      pageSize: q.pageSize,
      orderId: q.orderId,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      customerPhone: q.customerPhone
    });
    return res.json(result);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg === "INVALID_DATE_FROM" || msg === "INVALID_DATE_TO") {
      return res.status(400).json({ error: "Fecha inválida (dateFrom / dateTo)" });
    }
    throw e;
  }
}

const idParamSchema = z.object({
  id: z.string().uuid()
});

export async function getOrderById(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  if (await rejectIfOwnDeliveryBlocked(req, res, businessId)) return;

  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "id de orden inválido" });
  }

  const order = await getAdminOrderById(businessId, parsed.data.id);
  if (!order) {
    return res.status(404).json({ error: "Orden no encontrada" });
  }

  return res.json(order);
}

const patchDeliveryStatusSchema = z.object({
  status: z
    .nativeEnum(OrderStatus)
    .refine((s) => isAdminPatchableOrderStatus(s), {
      message: "Solo preparing, shipped o delivered"
    })
});

export async function patchOrderDeliveryStatus(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  if (await rejectIfOwnDeliveryBlocked(req, res, businessId)) return;

  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: "id de orden inválido" });
  }

  const bodyParsed = patchDeliveryStatusSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: bodyParsed.error.flatten()
    });
  }

  const result = await updateAdminOrderDeliveryStatus(
    businessId,
    paramsParsed.data.id,
    bodyParsed.data.status
  );

  if (!result) {
    return res.status(404).json({ error: "Orden no encontrada" });
  }

  return res.json(result);
}

const patchPaymentStatusSchema = z.object({
  payment_status: z.nativeEnum(OrderPaymentStatus)
});

export async function patchOrderPaymentStatus(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  if (await rejectIfOwnDeliveryBlocked(req, res, businessId)) return;

  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: "id de orden inválido" });
  }

  const bodyParsed = patchPaymentStatusSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: bodyParsed.error.flatten()
    });
  }

  const result = await updateAdminOrderPaymentStatus(
    businessId,
    paramsParsed.data.id,
    bodyParsed.data.payment_status
  );

  if (!result) {
    return res.status(404).json({ error: "Orden no encontrada" });
  }

  return res.json(result);
}
