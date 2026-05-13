import type { Request, Response } from "express";
import { z } from "zod";
import {
  createAdminDeliveryZone,
  deleteAdminDeliveryZone,
  getAdminDeliveryZoneById,
  listAdminDeliveryZones,
  type GeoJsonPolygon,
  updateAdminDeliveryZone
} from "../services/adminDeliveryZones.service";

const pointSchema = z.tuple([z.number(), z.number()]);

const polygonSchema: z.ZodType<GeoJsonPolygon> = z.object({
  type: z.literal("Polygon"),
  coordinates: z.array(z.array(pointSchema).min(4)).min(1)
});

function hasClosedRing(polygon: GeoJsonPolygon): boolean {
  return polygon.coordinates.every((ring) => {
    if (ring.length < 4) return false;
    const first = ring[0];
    const last = ring[ring.length - 1];
    return first[0] === last[0] && first[1] === last[1];
  });
}

const idParamSchema = z.object({
  id: z.string().uuid()
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(500).optional().nullable(),
  polygon: polygonSchema,
  deliveryFee: z.coerce.number().min(0).optional().nullable(),
  minOrderAmount: z.coerce.number().min(0).optional().nullable(),
  estimatedDeliveryMinutes: z.coerce.number().int().min(1).max(600).optional().nullable(),
  scheduleOverride: z.record(z.string(), z.any()).optional().nullable(),
  priority: z.coerce.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional()
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().max(500).optional().nullable(),
  polygon: polygonSchema.optional(),
  deliveryFee: z.coerce.number().min(0).optional().nullable(),
  minOrderAmount: z.coerce.number().min(0).optional().nullable(),
  estimatedDeliveryMinutes: z.coerce.number().int().min(1).max(600).optional().nullable(),
  scheduleOverride: z.record(z.string(), z.any()).optional().nullable(),
  priority: z.coerce.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional()
});

function validatePolygonOrFail(
  polygon: GeoJsonPolygon,
  res: Response
): boolean {
  if (hasClosedRing(polygon)) {
    return true;
  }

  res.status(400).json({
    error:
      "Polígono inválido: cada anillo debe tener al menos 4 puntos y cerrar repitiendo el primer punto al final."
  });
  return false;
}

export async function getDeliveryZones(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const result = await listAdminDeliveryZones({ businessId });
  return res.json(result);
}

export async function getDeliveryZoneById(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await getAdminDeliveryZoneById({
    businessId,
    id: parsedParams.data.id
  });
  if (!row) {
    return res.status(404).json({ error: "Zona de entrega no encontrada" });
  }

  return res.json(row);
}

export async function postDeliveryZone(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsed.error.flatten()
    });
  }

  if (!validatePolygonOrFail(parsed.data.polygon, res)) {
    return;
  }

  const row = await createAdminDeliveryZone({
    businessId,
    ...parsed.data
  });

  return res.status(201).json(row);
}

export async function patchDeliveryZone(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const parsedBody = updateSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsedBody.error.flatten()
    });
  }

  if (
    parsedBody.data.polygon &&
    !validatePolygonOrFail(parsedBody.data.polygon, res)
  ) {
    return;
  }

  const row = await updateAdminDeliveryZone({
    businessId,
    id: parsedParams.data.id,
    ...parsedBody.data
  });

  if (!row) {
    return res.status(404).json({ error: "Zona de entrega no encontrada" });
  }

  return res.json(row);
}

export async function removeDeliveryZone(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await deleteAdminDeliveryZone({
    businessId,
    id: parsedParams.data.id
  });

  if (!row) {
    return res.status(404).json({ error: "Zona de entrega no encontrada" });
  }

  return res.json({ success: true, id: row.id });
}
