import type { Request, Response } from "express";
import { z } from "zod";
import {
  getBusinessWithSubscriptionForSuperAdmin,
  listBusinessesForSuperAdmin
} from "../services/superAdminBusinesses.service";
import {
  SuperAdminCreateBusinessError,
  createBusinessForSuperAdmin
} from "../services/superAdminCreateBusiness.service";
import { DEFAULT_TRIAL_DAYS } from "../constants/billing";

const listQuerySchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  q: z.string().optional()
});

const idParamSchema = z.object({
  id: z.string().uuid()
});

export async function getSuperAdminBusinessesList(
  req: Request,
  res: Response
): Promise<void> {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "Parámetros inválidos",
      details: parsed.error.flatten()
    });
    return;
  }
  const { offset, limit, q } = parsed.data;
  const result = await listBusinessesForSuperAdmin({
    skip: offset,
    take: limit,
    q
  });
  res.json(result);
}

const createBodySchema = z.object({
  name: z.string().trim().min(1).max(160),
  timezone: z.string().trim().min(1).optional(),
  slug: z.string().trim().min(1).max(60).nullable().optional(),
  currency_code: z.string().trim().length(3).optional(),
  street_address: z.string().trim().max(240).nullable().optional(),
  description: z.string().trim().max(500).nullable().optional(),
  trial_days: z.number().int().positive().max(90).optional(),
  owner: z.object({
    email: z.string().trim().email(),
    name: z.string().trim().min(1).max(120),
    password: z.string().min(8).max(200).optional()
  })
});

export async function postSuperAdminBusiness(
  req: Request,
  res: Response
): Promise<void> {
  const parsed = createBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Body inválido",
      details: parsed.error.flatten()
    });
    return;
  }

  try {
    const created = await createBusinessForSuperAdmin({
      ...parsed.data,
      trial_days: parsed.data.trial_days ?? DEFAULT_TRIAL_DAYS
    });
    res.status(201).json(created);
  } catch (err) {
    if (err instanceof SuperAdminCreateBusinessError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    throw err;
  }
}

export async function getSuperAdminBusinessById(
  req: Request,
  res: Response
): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "id inválido" });
    return;
  }
  const row = await getBusinessWithSubscriptionForSuperAdmin(parsed.data.id);
  if (!row) {
    res.status(404).json({ error: "Negocio no encontrado" });
    return;
  }
  res.json(row);
}
