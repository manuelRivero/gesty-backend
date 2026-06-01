import type { Request, Response } from "express";
import { z } from "zod";
import {
  createAdminReservationSlot,
  deleteAdminReservationSlot,
  getAdminReservationSlotById,
  listAdminReservationSlots,
  updateAdminReservationSlot
} from "../services/adminReservationSlots.service";

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

const idParamSchema = z.object({
  id: z.string().uuid()
});

const optionalCapacityLimit = z.union([z.coerce.number().int().min(1), z.null()]).optional();

const createSchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(0).max(6),
    startTime: z.string().regex(HHMM_REGEX, "Formato inválido (HH:mm)"),
    endTime: z.string().regex(HHMM_REGEX, "Formato inválido (HH:mm)"),
    capacityLimit: optionalCapacityLimit,
    isActive: z.boolean().optional()
  })
  .superRefine((data, ctx) => {
    if (data.startTime >= data.endTime) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "endTime debe ser posterior a startTime"
      });
    }
  });

const updateSchema = z
  .object({
    dayOfWeek: z.coerce.number().int().min(0).max(6).optional(),
    startTime: z.string().regex(HHMM_REGEX, "Formato inválido (HH:mm)").optional(),
    endTime: z.string().regex(HHMM_REGEX, "Formato inválido (HH:mm)").optional(),
    capacityLimit: optionalCapacityLimit,
    isActive: z.boolean().optional()
  })
  .superRefine((data, ctx) => {
    if (
      data.startTime !== undefined &&
      data.endTime !== undefined &&
      data.startTime >= data.endTime
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endTime"],
        message: "endTime debe ser posterior a startTime"
      });
    }
  });

function mutationErrorResponse(
  res: Response,
  code: "INVALID_TIME_RANGE" | "SLOTS_OVERLAP"
) {
  if (code === "INVALID_TIME_RANGE") {
    return res.status(400).json({
      error: "Rango horario inválido",
      message: "endTime debe ser posterior a startTime"
    });
  }

  return res.status(409).json({
    error: "Slots solapados",
    message:
      "El slot se superpone con otro slot del mismo día. Ajustá los horarios para que no se crucen."
  });
}

export async function getReservationSlots(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const items = await listAdminReservationSlots({ businessId });
  return res.json({ items });
}

export async function getReservationSlotById(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await getAdminReservationSlotById({
    businessId,
    id: parsedParams.data.id
  });

  if (!row) {
    return res.status(404).json({ error: "Slot de reserva no encontrado" });
  }

  return res.json(row);
}

export async function postReservationSlot(req: Request, res: Response) {
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

  const row = await createAdminReservationSlot({
    businessId,
    dayOfWeek: parsed.data.dayOfWeek,
    startTime: parsed.data.startTime,
    endTime: parsed.data.endTime,
    capacityLimit: parsed.data.capacityLimit,
    isActive: parsed.data.isActive
  });

  if (row === "INVALID_TIME_RANGE" || row === "SLOTS_OVERLAP") {
    return mutationErrorResponse(res, row);
  }

  return res.status(201).json(row);
}

export async function patchReservationSlot(req: Request, res: Response) {
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

  const row = await updateAdminReservationSlot({
    businessId,
    id: parsedParams.data.id,
    dayOfWeek: parsedBody.data.dayOfWeek,
    startTime: parsedBody.data.startTime,
    endTime: parsedBody.data.endTime,
    capacityLimit: parsedBody.data.capacityLimit,
    isActive: parsedBody.data.isActive
  });

  if (row === "INVALID_TIME_RANGE" || row === "SLOTS_OVERLAP") {
    return mutationErrorResponse(res, row);
  }
  if (!row) {
    return res.status(404).json({ error: "Slot de reserva no encontrado" });
  }

  return res.json(row);
}

export async function removeReservationSlot(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: "id inválido" });
  }

  const row = await deleteAdminReservationSlot({
    businessId,
    id: parsedParams.data.id
  });

  if (!row) {
    return res.status(404).json({ error: "Slot de reserva no encontrado" });
  }

  return res.json({ success: true, id: row.id });
}
