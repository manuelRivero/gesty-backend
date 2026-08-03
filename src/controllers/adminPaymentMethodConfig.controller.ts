import type { Request, Response } from 'express';
import { z } from 'zod';
import { PAYMENT_METHOD_IDS } from '../domain/payment/paymentMethods';
import {
  PaymentMethodCombinationError,
  createAdminPaymentMethodConfig,
  deleteAdminPaymentMethodConfig,
  getAdminPaymentMethodConfigById,
  listAdminPaymentMethodConfigs,
  updateAdminPaymentMethodConfig,
} from '../services/adminPaymentMethodConfig.service';

const idParamSchema = z.object({ id: z.string().uuid() });

const paymentMethodEnum = z.enum(PAYMENT_METHOD_IDS);

const createSchema = z.object({
  paymentMethod: paymentMethodEnum,
  label: z.string().min(1).max(255),
  adjustmentType: z.enum(['PERCENT', 'FIXED']),
  adjustmentValue: z.number().min(0),
  isSurcharge: z.boolean(),
  isActive: z.boolean().optional(),
  instructions: z.string().max(2000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
}).refine(
  (v) => !(v.adjustmentType === 'PERCENT' && v.adjustmentValue > 100),
  { message: 'El porcentaje no puede superar el 100%', path: ['adjustmentValue'] }
);

const updateSchema = z.object({
  paymentMethod: paymentMethodEnum.optional(),
  label: z.string().min(1).max(255).optional(),
  adjustmentType: z.enum(['PERCENT', 'FIXED']).optional(),
  adjustmentValue: z.number().min(0).optional(),
  isSurcharge: z.boolean().optional(),
  isActive: z.boolean().optional(),
  instructions: z.string().max(2000).nullable().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
}).refine(
  (v) => !(v.adjustmentType === 'PERCENT' && v.adjustmentValue !== undefined && v.adjustmentValue > 100),
  { message: 'El porcentaje no puede superar el 100%', path: ['adjustmentValue'] }
);

function handleCombinationError(res: Response, err: unknown): boolean {
  if (err instanceof PaymentMethodCombinationError) {
    res.status(409).json({ error: err.message });
    return true;
  }
  return false;
}

export async function getPaymentMethodConfigs(req: Request, res: Response): Promise<void> {
  const businessId = req.user?.businessId;
  if (!businessId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const result = await listAdminPaymentMethodConfigs(businessId);
  res.json(result);
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
  } catch (err: unknown) {
    if (handleCombinationError(res, err)) return;
    if ((err as { code?: string })?.code === 'P2002') {
      res.status(409).json({ error: `Ya existe una configuración para el método "${parsed.data.paymentMethod}"` });
      return;
    }
    throw err;
  }
}

export async function patchPaymentMethodConfig(req: Request, res: Response): Promise<void> {
  const parsedId = idParamSchema.safeParse(req.params);
  if (!parsedId.success) { res.status(400).json({ error: parsedId.error.flatten() }); return; }

  const businessId = req.user?.businessId;
  if (!businessId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.flatten() }); return; }

  try {
    const config = await updateAdminPaymentMethodConfig(businessId, parsedId.data.id, parsed.data);
    if (!config) { res.status(404).json({ error: 'Configuración no encontrada' }); return; }
    res.json(config);
  } catch (err: unknown) {
    if (handleCombinationError(res, err)) return;
    throw err;
  }
}

export async function removePaymentMethodConfig(req: Request, res: Response): Promise<void> {
  const parsedId = idParamSchema.safeParse(req.params);
  if (!parsedId.success) { res.status(400).json({ error: parsedId.error.flatten() }); return; }

  const businessId = req.user?.businessId;
  if (!businessId) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const deleted = await deleteAdminPaymentMethodConfig(businessId, parsedId.data.id);
    if (!deleted) { res.status(404).json({ error: 'Configuración no encontrada' }); return; }
    res.status(204).send();
  } catch (err: unknown) {
    if (handleCombinationError(res, err)) return;
    throw err;
  }
}
