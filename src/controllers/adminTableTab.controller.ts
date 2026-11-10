import type { Request, Response } from "express";
import { z } from "zod";
import {
  assignTableToTab,
  closeTableTab,
  getTableTabById,
  listOccupiedTableIds,
  listOpenTableTabs,
  listTableTabOrders,
  openTableTab,
  reassignTableTab,
  transferTable
} from "../services/adminTableTab.service";
import { createTableTabRound } from "../services/adminTableTabRound.service";
import { cancelOrderItem } from "../services/kitchenTicketItem.service";
import { getBusinessUserIdForActor } from "../services/businessUserContext.service";
import { getTableTabBalance, hasTableTabOrders } from "../services/tabPayment.service";
import { prisma } from "../lib/prisma";
import { OrderItemAdjustmentReason } from "@prisma/client";
import type { BusinessUserRole } from "../types/auth";

/** Alineado con UUID en PostgreSQL; Zod `.uuid()` rechaza variantes RFC. */
const postgresUuid = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "UUID inválido"
);

const idParamSchema = z.object({ id: postgresUuid });

const openSchema = z.object({
  tableId: postgresUuid
});

const assignTableSchema = z.object({
  tableId: postgresUuid
});

const transferSchema = z.object({
  fromTableId: postgresUuid,
  toTableId: postgresUuid
});

const reassignSchema = z.object({
  assignedUserId: postgresUuid
});

const createRoundSchema = z.object({
  items: z
    .array(
      z.object({
        menuItemId: postgresUuid,
        quantity: z.coerce.number().int().min(1).max(99),
        notes: z.string().trim().max(500).optional(),
        variation: z.string().trim().min(1).max(120).optional()
      })
    )
    .min(1)
    .max(50)
});

function requireAuth(
  req: Request,
  res: Response
): { businessId: string; userId: string; role: BusinessUserRole } | null {
  const businessId = req.user?.businessId;
  const userId = req.user?.userId;
  const role = req.user?.role;
  if (!businessId || !userId || !role) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  return { businessId, userId, role };
}

/**
 * `req.user.userId` (JWT) es `AppUser.id`, no `business_user.id` — las FKs de
 * salón (`table_tab.opened_by_user_id`, `order_item_adjustment.requested_by_user_id`,
 * etc.) apuntan a `business_user`, igual que `orders.assigned_delivery_user_id`
 * ya resolvía vía `getBusinessUserIdForActor` (`adminOrders.controller.ts`).
 * Devuelve 403 si el actor autenticado no tiene membresía en este negocio
 * (no debería pasar para un JWT válido, pero una FK rota en producción es
 * peor que un 403 bien explicado).
 */
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

const cancelItemSchema = z.object({
  orderItemId: postgresUuid,
  reason: z.nativeEnum(OrderItemAdjustmentReason).optional()
});

export async function getTableTabs(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const rows = await listOpenTableTabs({ businessId: auth.businessId });

  // Saldo por cuenta — solo ADMIN/OWNER (caja/encargado). El mozo nunca ve
  // montos (§4.F); por eso esto no es parte del DTO base de `listOpenTableTabs`,
  // se agrega acá condicionalmente según el rol del actor autenticado.
  // Sirve, entre otras cosas, para que el panel pinte "lista para cerrar" las
  // mesas con saldo en $0 que todavía no se cerraron.
  if (auth.role !== "ADMIN" && auth.role !== "OWNER") {
    return res.json({ items: rows });
  }

  const items = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      balance: await getTableTabBalance(prisma, auth.businessId, row.id),
      // Para que el admin no pinte de amarillo ("lista para cerrar") una mesa
      // recién abierta sin ítems — ambas tienen saldo $0, pero solo la que
      // tuvo órdenes y ya las pagó está lista para cerrarse.
      hasOrders: await hasTableTabOrders(prisma, auth.businessId, row.id)
    }))
  );
  return res.json({ items });
}

export async function getOccupiedTables(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const occupied = await listOccupiedTableIds({ businessId: auth.businessId });
  return res.json({ tableIds: Array.from(occupied) });
}

export async function getTableTabById_(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await getTableTabById({ businessId: auth.businessId, id: parsedParams.data.id });
  if (!row) {
    return res.status(404).json({ error: "Cuenta de mesa no encontrada" });
  }
  return res.json(row);
}

/** "El pedido" de la cuenta — rondas + ítems, para el sidebar de `/pos`. */
export async function getTableTabOrders(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const items = await listTableTabOrders({
    businessId: auth.businessId,
    tableTabId: parsedParams.data.id
  });
  return res.json({ items });
}

export async function postOpenTableTab(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const businessUserId = await resolveActorBusinessUserId(req, res, auth);
  if (!businessUserId) return;

  const result = await openTableTab({
    businessId: auth.businessId,
    tableId: parsed.data.tableId,
    openedByUserId: businessUserId
  });

  if (!result.ok) {
    if (result.reason === "TABLE_NOT_FOUND") {
      return res.status(404).json({ error: "Mesa no encontrada" });
    }
    return res.status(409).json({ error: "La mesa ya tiene una cuenta abierta" });
  }

  return res.status(201).json(result.tableTab);
}

export async function postAssignTableToTab(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }
  const parsed = assignTableSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const result = await assignTableToTab({
    businessId: auth.businessId,
    tableTabId: parsedParams.data.id,
    tableId: parsed.data.tableId
  });

  if (!result.ok) {
    const statusByReason: Record<typeof result.reason, number> = {
      TABLE_TAB_NOT_FOUND: 404,
      TABLE_TAB_NOT_OPEN: 409,
      TABLE_NOT_FOUND: 404,
      TABLE_ALREADY_OCCUPIED: 409
    };
    return res.status(statusByReason[result.reason]).json({ error: result.reason });
  }

  return res.json(result.tableTab);
}

export async function postTransferTable(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }
  const parsed = transferSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const result = await transferTable({
    businessId: auth.businessId,
    tableTabId: parsedParams.data.id,
    fromTableId: parsed.data.fromTableId,
    toTableId: parsed.data.toTableId
  });

  if (!result.ok) {
    const statusByReason: Record<typeof result.reason, number> = {
      TABLE_TAB_NOT_FOUND: 404,
      TABLE_TAB_NOT_OPEN: 409,
      SOURCE_TABLE_NOT_ASSIGNED: 409,
      TARGET_TABLE_NOT_FOUND: 404,
      TARGET_TABLE_ALREADY_OCCUPIED: 409
    };
    return res.status(statusByReason[result.reason]).json({ error: result.reason });
  }

  return res.json(result.tableTab);
}

export async function patchReassignTableTab(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }
  const parsed = reassignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const result = await reassignTableTab({
    businessId: auth.businessId,
    tableTabId: parsedParams.data.id,
    assignedUserId: parsed.data.assignedUserId
  });

  if (!result.ok) {
    return res.status(result.reason === "TABLE_TAB_NOT_FOUND" ? 404 : 409).json({ error: result.reason });
  }

  return res.json(result.tableTab);
}

export async function postCreateTableTabRound(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }
  const parsed = createRoundSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const result = await createTableTabRound({
    businessId: auth.businessId,
    tableTabId: parsedParams.data.id,
    items: parsed.data.items
  });

  if (!result.ok) {
    const statusByReason: Record<typeof result.reason, number> = {
      EMPTY_ROUND: 400,
      TABLE_TAB_NOT_FOUND: 404,
      TABLE_TAB_NOT_OPEN: 409,
      MENU_ITEM_NOT_FOUND: 404,
      MENU_ITEM_UNAVAILABLE: 409,
      PRICE_NOT_AVAILABLE: 409
    };
    return res
      .status(statusByReason[result.reason])
      .json({ error: result.reason, menuItemId: result.menuItemId });
  }

  return res.status(201).json({ orderId: result.orderId, total: result.total });
}

export async function postCancelTableTabItem(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }
  const parsed = cancelItemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const businessUserId = await resolveActorBusinessUserId(req, res, auth);
  if (!businessUserId) return;

  const result = await cancelOrderItem({
    businessId: auth.businessId,
    tableTabId: parsedParams.data.id,
    orderItemId: parsed.data.orderItemId,
    userId: businessUserId,
    userRole: auth.role,
    reason: parsed.data.reason
  });

  if (!result.ok) {
    const statusByReason: Record<typeof result.reason, number> = {
      ORDER_ITEM_NOT_FOUND: 404,
      ALREADY_CANCELED: 409,
      ROLE_NOT_ALLOWED: 403,
      REASON_REQUIRED: 400,
      CONCURRENT_STATUS_CHANGE: 409
    };
    return res.status(statusByReason[result.reason]).json({ error: result.reason });
  }

  return res.json({ adjustmentId: result.adjustmentId, amount: result.amount });
}

export async function postCloseTableTab(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const result = await closeTableTab({
    businessId: auth.businessId,
    tableTabId: parsedParams.data.id
  });

  if (!result.ok) {
    return res.status(result.reason === "TABLE_TAB_NOT_FOUND" ? 404 : 409).json({ error: result.reason });
  }

  // `hasPendingKitchenItems`: advertencia blanda (§4.B) — el cierre ya
  // ocurrió, el frontend decide si muestra un modal informativo al respecto.
  return res.json({ ...result.tableTab, hasPendingKitchenItems: result.hasPendingKitchenItems });
}
