import type { Request, Response } from "express";
import { z } from "zod";
import {
  createAdminBusinessHour,
  deleteAdminBusinessHour,
  getAdminBusinessHourById,
  listAdminBusinessHours,
  updateAdminBusinessHour
} from "../services/adminBusinessHours.service";

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

const idParamSchema = z.object({
  id: z.string().uuid()
});

const createSchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(0).max(6),
    opensAt: z.string().regex(HHMM_REGEX, "Formato inválido (HH:mm)"),
    closesAt: z.string().regex(HHMM_REGEX, "Formato inválido (HH:mm)"),
    isClosed: z.boolean().optional()
  })
  .superRefine((data, ctx) => {
    if (data.isClosed !== true && data.opensAt === data.closesAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closesAt"],
        message: "closesAt no puede ser igual a opensAt"
      });
    }
  });

const updateSchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(0).max(6).optional(),
    opensAt: z.string().regex(HHMM_REGEX, "Formato inválido (HH:mm)").optional(),
    closesAt: z.string().regex(HHMM_REGEX, "Formato inválido (HH:mm)").optional(),
    isClosed: z.boolean().optional()
  })
  .superRefine((data, ctx) => {
    if (
      data.isClosed !== true &&
      data.opensAt !== undefined &&
      data.closesAt !== undefined &&
      data.opensAt === data.closesAt
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["closesAt"],
        message: "closesAt no puede ser igual a opensAt"
      });
    }
  });

export async function getBusinessHours(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const items = await listAdminBusinessHours({ businessId });
  return res.json({ items });
}

export async function getBusinessHourById(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await getAdminBusinessHourById({
    businessId,
    id: parsedParams.data.id
  });

  if (!row) {
    return res.status(404).json({ error: "Horario no encontrado" });
  }

  return res.json(row);
}

export async function postBusinessHour(req: Request, res: Response) {
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

  const row = await createAdminBusinessHour({
    businessId,
    dayOfWeek: parsed.data.dayOfWeek,
    opensAt: parsed.data.opensAt,
    closesAt: parsed.data.closesAt,
    isClosed: parsed.data.isClosed
  });

  return res.status(201).json(row);
}

export async function patchBusinessHour(req: Request, res: Response) {
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

  const row = await updateAdminBusinessHour({
    businessId,
    id: parsedParams.data.id,
    dayOfWeek: parsedBody.data.dayOfWeek,
    opensAt: parsedBody.data.opensAt,
    closesAt: parsedBody.data.closesAt,
    isClosed: parsedBody.data.isClosed
  });

  if (!row) {
    return res.status(404).json({ error: "Horario no encontrado" });
  }

  return res.json(row);
}

export async function removeBusinessHour(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await deleteAdminBusinessHour({
    businessId,
    id: parsedParams.data.id
  });

  if (!row) {
    return res.status(404).json({ error: "Horario no encontrado" });
  }

  return res.json({ success: true, id: row.id });
}
