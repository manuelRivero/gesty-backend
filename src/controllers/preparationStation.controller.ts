import type { Request, Response } from "express";
import { z } from "zod";
import {
  assignMenuItemStation,
  createPreparationStation,
  listPreparationStations
} from "../services/preparationStation.service";

const postgresUuid = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "UUID inválido"
);

const idParamSchema = z.object({ id: postgresUuid });
const createStationSchema = z.object({ name: z.string().trim().min(1).max(120) });
const assignMenuItemSchema = z.object({ menuItemId: postgresUuid });

function requireAuth(req: Request, res: Response): { businessId: string } | null {
  const businessId = req.user?.businessId;
  if (!businessId) {
    res.status(401).json({ error: "No autenticado" });
    return null;
  }
  return { businessId };
}

export async function getPreparationStations(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const items = await listPreparationStations({ businessId: auth.businessId });
  return res.json({ items });
}

export async function postPreparationStation(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsed = createStationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const station = await createPreparationStation({
    businessId: auth.businessId,
    name: parsed.data.name
  });
  return res.status(201).json(station);
}

export async function postAssignMenuItemStation(req: Request, res: Response) {
  const auth = requireAuth(req, res);
  if (!auth) return;

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }
  const parsed = assignMenuItemSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Body inválido", details: parsed.error.flatten() });
  }

  const result = await assignMenuItemStation({
    businessId: auth.businessId,
    stationId: parsedParams.data.id,
    menuItemId: parsed.data.menuItemId
  });

  if (!result.ok) {
    const statusByReason: Record<typeof result.reason, number> = {
      STATION_NOT_FOUND: 404,
      MENU_ITEM_NOT_FOUND: 404
    };
    return res.status(statusByReason[result.reason]).json({ error: result.reason });
  }

  return res.status(201).json(result.assignment);
}
