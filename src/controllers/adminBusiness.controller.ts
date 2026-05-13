import type { Request, Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { getBusinessConfig } from "../services/businessConfig.service";

const businessPatchSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  street_address: z.string().nullable().optional(),
  address_notes: z.string().nullable().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  timezone: z.string().optional(),
  slug: z.string().min(1).nullable().optional()
});

export async function getAdminBusiness(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const business = await prisma.business.findUnique({
    where: { id: businessId },
    select: {
      id: true,
      name: true,
      description: true,
      street_address: true,
      address_notes: true,
      latitude: true,
      longitude: true,
      timezone: true,
      slug: true,
      currency_code: true,
      is_active: true
    }
  });
  if (!business) {
    return res.status(404).json({ error: "Business no encontrado" });
  }
  return res.json(business);
}

export async function patchAdminBusiness(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsed = businessPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsed.error.flatten()
    });
  }

  const data = parsed.data;

  // Si el patch borra la dirección, verificar que takeaway no esté activo
  if (data.street_address === null || data.street_address === "") {
    const config = await getBusinessConfig(businessId);
    if (config.takeaway_enabled) {
      return res.status(400).json({
        error: "No se puede eliminar la dirección del local mientras el retiro en local esté habilitado. Deshabilite 'takeaway_enabled' primero."
      });
    }
  }

  const updated = await prisma.business.update({
    where: { id: businessId },
    data,
    select: {
      id: true,
      name: true,
      description: true,
      street_address: true,
      address_notes: true,
      latitude: true,
      longitude: true,
      timezone: true,
      slug: true,
      currency_code: true,
      is_active: true
    }
  });

  return res.json(updated);
}
