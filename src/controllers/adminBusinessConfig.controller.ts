import type { Request, Response } from "express";
import { z } from "zod";
import {
  deleteBusinessConfig,
  getBusinessConfig,
  upsertBusinessConfig
} from "../services/businessConfig.service";

const configPatchSchema = z.object({
  bot_enabled: z.boolean().optional(),
  allow_human_handoff: z.boolean().optional(),
  human_handoff_auto_timeout_minutes: z.number().int().positive().nullable().optional(),
  send_idle_reminders: z.boolean().optional(),
  idle_reminder_minutes: z.number().int().positive().optional(),
  idle_close_minutes: z.number().int().positive().optional(),
  send_order_reminders: z.boolean().optional(),
  draft_order_reminder_minutes: z.number().int().positive().optional(),
  draft_order_expire_minutes: z.number().int().positive().optional(),
  reservations_enabled: z.boolean().optional(),
  reservation_min_lead_minutes: z.number().int().min(0).optional(),
  reservation_max_days_ahead: z.number().int().positive().optional(),
  reservation_default_duration_minutes: z.number().int().positive().optional(),
  reservation_require_confirmation: z.boolean().optional(),
  reservation_allow_same_day: z.boolean().optional(),
  orders_enabled: z.boolean().optional(),
  checkout_enabled: z.boolean().optional(),
  delivery_enabled: z.boolean().optional(),
  takeaway_enabled: z.boolean().optional(),
  pickup_instructions: z.string().nullable().optional(),
  humanize_messages: z.boolean().optional(),
  operate_when_closed: z.boolean().optional(),
  orders_when_closed: z.boolean().optional()
}).refine(
  (data) => {
    const disableDelivery = data.delivery_enabled === false;
    const disableTakeaway = data.takeaway_enabled === false;
    return !(disableDelivery && disableTakeaway);
  },
  {
    message: "Al menos uno de delivery_enabled o takeaway_enabled debe ser true",
    path: ["delivery_enabled"]
  }
);

export async function getAdminBusinessConfig(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const cfg = await getBusinessConfig(businessId);
  return res.json(cfg);
}

export async function createAdminBusinessConfig(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const parsed = configPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsed.error.flatten()
    });
  }
  const cfg = await upsertBusinessConfig(businessId, parsed.data);
  return res.status(201).json(cfg);
}

export async function patchAdminBusinessConfig(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }
  const parsed = configPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Body inválido",
      details: parsed.error.flatten()
    });
  }
  const cfg = await upsertBusinessConfig(businessId, parsed.data);
  return res.json(cfg);
}

export async function removeAdminBusinessConfig(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: "No autenticado" });
  }
  await deleteBusinessConfig(businessId);
  return res.status(204).send();
}
