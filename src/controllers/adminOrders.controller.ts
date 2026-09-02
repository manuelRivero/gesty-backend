import { FulfillmentType, OrderPaymentStatus, OrderStatus } from "@prisma/client";
import type { Request, Response } from "express";
import { z } from "zod";
import { isAdminPatchableOrderStatus } from "../constants/orderWorkflow";
import {
  getAdminOrderById,
  listAdminOrders,
  updateAdminOrderDeliveryStatus,
  updateAdminOrderPaymentStatus
} from "../services/adminOrders.service";
import { getBusinessUserIdForActor } from "../services/businessUserContext.service";
import { getBusinessConfig } from "../services/businessConfig.service";
import {
  EXTERNAL_DELIVERY_MANAGED_ERROR,
  isOwnDeliveryBlocked
} from "../services/externalDeliveryGuard.service";
import {
  assignOrderDelivery,
  canDeliveryAccessOrder,
  OrderDeliveryAssignmentError
} from "../services/orderDeliveryAssignment.service";
import type { BusinessUserRole } from "../types/auth";

const DELIVERY_ACCESS_DENIED = "No tenés permiso para acceder a este pedido";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  orderId: z.string().uuid().optional(),
  dateFrom: z.string().min(1).optional(),
  dateTo: z.string().min(1).optional(),
  customerPhone: z.string().min(1).optional(),
  fulfillmentType: z.nativeEnum(FulfillmentType).optional(),
  assignment: z.enum(["all", "assigned", "unassigned"]).optional(),
  assignedDeliveryUserId: z.string().uuid().optional()
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

async function resolveActorBusinessUserId(
  req: Request,
  businessId: string
): Promise<string | null> {
  const userId = req.user?.userId;
  if (!userId) return null;
  return getBusinessUserIdForActor({ userId, businessId });
}

async function rejectIfDeliveryCannotAccessOrder(
  req: Request,
  res: Response,
  businessId: string,
  order: {
    assigned_delivery_user_id: string | null;
    fulfillment_type: FulfillmentType | null;
  }
): Promise<boolean> {
  if (req.user?.role !== "DELIVERY") return false;

  const actorBusinessUserId = await resolveActorBusinessUserId(req, businessId);
  if (
    !actorBusinessUserId ||
    !canDeliveryAccessOrder({ order, actorBusinessUserId })
  ) {
    res.status(403).json({ error: DELIVERY_ACCESS_DENIED });
    return true;
  }

  return false;
}

function assignmentErrorStatus(code: OrderDeliveryAssignmentError["code"]): number {
  switch (code) {
    case "NOT_FOUND":
      return 404;
    case "ORDER_ALREADY_DELIVERED":
      return 409;
    case "NOT_DELIVERY_USER":
    case "ORDER_NOT_DELIVERY":
      return 400;
    default:
      return 400;
  }
}

export async function getOrders(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const actorRole = req.user?.role as BusinessUserRole | undefined;

  // El rol DELIVERY usa este endpoint para listar los pedidos que debe entregar.
  // Con delivery externo activo, ningún pedido es gestionado por el rider propio.
  if (actorRole === "DELIVERY") {
    const config = await getBusinessConfig(businessId);
    if (
      isOwnDeliveryBlocked({
        role: actorRole,
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

  const actorBusinessUserId =
    actorRole === "DELIVERY"
      ? await resolveActorBusinessUserId(req, businessId)
      : undefined;

  const q = parsed.data;
  try {
    const result = await listAdminOrders({
      businessId,
      page: q.page,
      pageSize: q.pageSize,
      orderId: q.orderId,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      customerPhone: q.customerPhone,
      fulfillmentType: q.fulfillmentType,
      assignment: q.assignment,
      assignedDeliveryUserId: q.assignedDeliveryUserId,
      actorRole,
      actorBusinessUserId: actorBusinessUserId ?? undefined
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

  if (await rejectIfDeliveryCannotAccessOrder(req, res, businessId, order)) {
    return;
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

  const existing = await getAdminOrderById(businessId, paramsParsed.data.id);
  if (!existing) {
    return res.status(404).json({ error: "Orden no encontrada" });
  }

  if (await rejectIfDeliveryCannotAccessOrder(req, res, businessId, existing)) {
    return;
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

  const existing = await getAdminOrderById(businessId, paramsParsed.data.id);
  if (!existing) {
    return res.status(404).json({ error: "Orden no encontrada" });
  }

  if (await rejectIfDeliveryCannotAccessOrder(req, res, businessId, existing)) {
    return;
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

const patchDeliveryAssignmentSchema = z.object({
  assignedDeliveryUserId: z.string().uuid().nullable()
});

export async function patchOrderDeliveryAssignment(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const paramsParsed = idParamSchema.safeParse(req.params);
  if (!paramsParsed.success) {
    return res.status(400).json({ error: "id de orden inválido" });
  }

  const bodyParsed = patchDeliveryAssignmentSchema.safeParse(req.body);
  if (!bodyParsed.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: bodyParsed.error.flatten()
    });
  }

  try {
    const order = await assignOrderDelivery({
      businessId,
      orderId: paramsParsed.data.id,
      assignedDeliveryUserId: bodyParsed.data.assignedDeliveryUserId
    });
    return res.json({ order });
  } catch (err) {
    if (err instanceof OrderDeliveryAssignmentError) {
      return res.status(assignmentErrorStatus(err.code)).json({
        error: err.message,
        code: err.code
      });
    }
    throw err;
  }
}
