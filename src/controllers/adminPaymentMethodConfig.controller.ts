import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createAdminPaymentMethodConfig,
  deleteAdminPaymentMethodConfig,
  getAdminPaymentMethodConfigById,
  listAdminPaymentMethodConfigs,
  updateAdminPaymentMethodConfig,
} from '../services/adminPaymentMethodConfig.service';

const idParamSchema = z.object({ id: z.string().uuid() });

const createSchema = z.object({
  paymentMethod: z.string().min(1).max(50),
  label: z.string().min(1).max(255),
  adjustmentType: z.enum(['PERCENT', 'FIXED']),
  adjustmentValue: z.number().min(0),
  isSurcharge: z.boolean(),
  isActive: z.boolean().optional(),
}).refine(
  (v) => !(v.adjustmentType === 'PERCENT' && v.adjustmentValue > 100),
  { message: 'El porcentaje no puede superar el 100%', path: ['adjustmentValue'] }
);

const updateSchema = z.object({
  paymentMethod: z.string().min(1).max(50).optional(),
  label: z.string().min(1).max(255).optional(),
  adjustmentType: z.enum(['PERCENT', 'FIXED']).optional(),
  adjustmentValue: z.number().min(0).optional(),
  isSurcharge: z.boolean().optional(),
  isActive: z.boolean().optional(),
}).refine(
  (v) => !(v.adjustmentType === 'PERCENT' && v.adjustmentValue !== undefined && v.adjustmentValue > 100),
  { message: 'El porcentaje no puede superar el 100%', path: ['adjustmentValue'] }
);

export async function getPaymentMethodConfigs(req: Request, res: Response): Promise<void> {
  const businessId = req.user?.businessId;
  if (!businessId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const configs = await listAdminPaymentMethodConfigs(businessId);
  res.json(configs);
}

export async function getPaymentMethodConfigById(req: Request, res: Response): Promise<void> {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const businessId = req.user?.businessId;
  if (!businessId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const config = await getAdminPaymentMethodConfigById(businessId, parsed.data.id);
  if (!config) { res.status(404).json({ error: 'Configuración no encontrada' }); return; }
  res.json(config);
}

export async function postPaymentMethodConfig(req: Request, res: Response): Promise<void> {
  const businessId = req.user?.businessId;
  if (!businessId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  try {
    const config = await createAdminPaymentMethodConfig(businessId, parsed.data);
    res.status(201).json(config);
  } catch (err: any) {
    if (err?.code === 'P2002') {
      res.status(409).json({ error: `Ya existe una configuración para el método "${parsed.data.paymentMethod}"` });
    } else {
      throw err;
    }
  }
}

export async function patchPaymentMethodConfig(req: Request, res: Response): Promise<void> {
  const parsedId = idParamSchema.safeParse(req.params);
  if (!parsedId.success) { res.status(400).json({ error: parsedId.error.flatten() }); return; }

  const businessId = req.user?.businessId;
  if (!businessId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  const config = await updateAdminPaymentMethodConfig(businessId, parsedId.data.id, parsed.data);
  if (!config) { res.status(404).json({ error: 'Configuración no encontrada' }); return; }
  res.json(config);
}

export async function removePaymentMethodConfig(req: Request, res: Response): Promise<void> {
  const parsedId = idParamSchema.safeParse(req.params);
  if (!parsedId.success) { res.status(400).json({ error: parsedId.error.flatten() }); return; }

  const businessId = req.user?.businessId;
  if (!businessId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const deleted = await deleteAdminPaymentMethodConfig(businessId, parsedId.data.id);
  if (!deleted) { res.status(404).json({ error: 'Configuración no encontrada' }); return; }
  res.status(204).send();
}
