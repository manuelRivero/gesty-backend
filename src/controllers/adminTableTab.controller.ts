import type { Request, Response } from "express";
import { z } from "zod";
import {
  assignTableToTab,
  closeTableTab,
  getTableTabById,
  listOccupiedTableIds,
  listOpenTableTabs,
  openTableTab,
  reassignTableTab,
  transferTable
} from "../services/adminTableTab.service";

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

function requireAuth(req: Request, res: Response): { businessId: string; userId: string } | null {
  const businessId = req.user?.businessId;
  const userId = req.user?.userId;
  if (!businessId || !userId) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  return { businessId, userId };
}

export async function getTableTabs(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const items = await listOpenTableTabs({ businessId: auth.businessId });
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

export async function postOpenTableTab(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = openSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const result = await openTableTab({
    businessId: auth.businessId,
    tableId: parsed.data.tableId,
    openedByUserId: auth.userId
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

  return res.json(result.tableTab);
}
