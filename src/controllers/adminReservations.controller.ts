import type { Request, Response } from "express";
import { z } from "zod";
import {
  getAdminReservationById,
  listAdminReservations
} from "../services/adminReservations.service";

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  reservationId: z.string().uuid().optional(),
  dateFrom: z.string().min(1).optional(),
  dateTo: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  customerPhone: z.string().min(1).optional()
});

export async function getReservations(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
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
    const result = await listAdminReservations({
      businessId,
      page: q.page,
      pageSize: q.pageSize,
      reservationId: q.reservationId,
      dateFrom: q.dateFrom,
      dateTo: q.dateTo,
      status: q.status,
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

export async function getReservationById(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }

  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: "id de reserva inválido" });
  }

  const row = await getAdminReservationById(businessId, parsed.data.id);
  if (!row) {
    return res.status(404).json({ error: "Reserva no encontrada" });
  }

  return res.json(row);
}
