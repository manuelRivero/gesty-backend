import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  createAdminPaymentProvider,
  deleteAdminPaymentProvider,
  getAdminPaymentProviderById,
  isPaymentProviderId,
  listAdminPaymentProviders,
  PaymentProviderAlreadyExistsError,
  PaymentProviderValidationError,
  updateAdminPaymentProvider,
} from '../services/adminPaymentProviders.service';

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const providerSchema = z
  .string()
  .trim()
  .refine(isPaymentProviderId, { message: 'Proveedor no soportado' });

const createSchema = z.object({
  provider: providerSchema,
  accessToken: z.string().trim().min(1),
  publicKey: z.string().trim().min(1).optional().nullable(),
  webhookSecret: z.string().trim().min(1).optional().nullable(),
  isSandbox: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

const updateSchema = z.object({
  accessToken: z.string().trim().min(1).optional(),
  publicKey: z.string().trim().min(1).optional().nullable(),
  webhookSecret: z.string().trim().min(1).optional().nullable(),
  isSandbox: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

function handleServiceError(err: unknown, res: Response): boolean {
  if (err instanceof PaymentProviderValidationError) {
    res.status(400).json({ error: err.message });
    return true;
  }

  if (err instanceof PaymentProviderAlreadyExistsError) {
    res.status(409).json({ error: err.message });
    return true;
  }

  if (err instanceof Error && err.message.includes('PAYMENT_PROVIDER_ENCRYPTION_KEY')) {
    res.status(503).json({
      error: 'El servidor no tiene configurada la clave de cifrado de proveedores de pago',
    });
    return true;
  }

  return false;
}

export async function getPaymentProviders(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const result = await listAdminPaymentProviders({ businessId });
  return res.json(result);
}

export async function getPaymentProviderById(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'id inválido' });
  }

  const row = await getAdminPaymentProviderById({
    businessId,
    id: parsedParams.data.id,
  });

  if (!row) {
    return res.status(404).json({ error: 'Proveedor de pago no encontrado' });
  }

  return res.json(row);
}

export async function postPaymentProvider(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Body inválido',
      details: parsed.error.flatten(),
    });
  }

  try {
    const row = await createAdminPaymentProvider({
      businessId,
      provider: parsed.data.provider,
      accessToken: parsed.data.accessToken,
      publicKey: parsed.data.publicKey,
      webhookSecret: parsed.data.webhookSecret,
      isSandbox: parsed.data.isSandbox,
      isActive: parsed.data.isActive,
    });

    return res.status(201).json(row);
  } catch (err) {
    if (handleServiceError(err, res)) {
      return;
    }
    throw err;
  }
}

export async function patchPaymentProvider(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'id inválido' });
  }

  const parsedBody = updateSchema.safeParse(req.body);
  if (!parsedBody.success) {
    return res.status(400).json({
      error: 'Body inválido',
      details: parsedBody.error.flatten(),
    });
  }

  try {
    const row = await updateAdminPaymentProvider({
      businessId,
      id: parsedParams.data.id,
      accessToken: parsedBody.data.accessToken,
      publicKey: parsedBody.data.publicKey,
      webhookSecret: parsedBody.data.webhookSecret,
      isSandbox: parsedBody.data.isSandbox,
      isActive: parsedBody.data.isActive,
    });

    if (!row) {
      return res.status(404).json({ error: 'Proveedor de pago no encontrado' });
    }

    return res.json(row);
  } catch (err) {
    if (handleServiceError(err, res)) {
      return;
    }
    throw err;
  }
}

export async function removePaymentProvider(req: Request, res: Response) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const parsedParams = idParamSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({ error: 'id inválido' });
  }

  const row = await deleteAdminPaymentProvider({
    businessId,
    id: parsedParams.data.id,
  });

  if (!row) {
    return res.status(404).json({ error: 'Proveedor de pago no encontrado' });
  }

  return res.json({ success: true, id: row.id });
}
