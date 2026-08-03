/**
 * Endpoints admin de calibración PedidosYa.
 * Feature dormida: sin PEDIDOSYA_* → 503. No promocionar en UI hasta smoke real.
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  calibrateDeliveryZones,
  getDeliveryZoneCalibrationStatus,
  PedidosYaApiError,
  PedidosYaNotConfiguredError,
} from '../services/deliveryZoneCalibration.service';

const calibrateBodySchema = z.object({
  safetyBufferPercent: z.coerce.number().min(0).max(100).optional(),
});

/**
 * GET /admin/delivery-zones/calibration/status
 * Indica si el SaaS tiene PedidosYa configurado (sin exponer secretos).
 */
export async function getDeliveryZoneCalibrationStatusHandler(
  req: Request,
  res: Response
) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  return res.json(getDeliveryZoneCalibrationStatus());
}

/**
 * POST /admin/delivery-zones/calibration
 * Cotiza puntos representativos de cada zona activa vs PedidosYa y sugiere fees.
 */
export async function postDeliveryZoneCalibrationHandler(
  req: Request,
  res: Response
) {
  const businessId = req.user?.businessId;
  if (!businessId) {
    return res.status(401).json({ error: 'No autenticado' });
  }

  const parsed = calibrateBodySchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Body inválido',
      details: parsed.error.flatten(),
    });
  }

  try {
    const report = await calibrateDeliveryZones({
      businessId,
      safetyBufferPercent: parsed.data.safetyBufferPercent,
    });
    return res.json(report);
  } catch (err) {
    if (err instanceof PedidosYaNotConfiguredError) {
      return res.status(503).json({
        error:
          'PedidosYa no está configurado en el servidor. Contactá al administrador del SaaS.',
        configured: false,
      });
    }

    if (err instanceof PedidosYaApiError) {
      return res.status(502).json({
        error: err.message,
        status: err.status,
      });
    }

    if (err instanceof Error) {
      // Errores de precondiciones del negocio (sin lat/lng, sin zonas, etc.)
      return res.status(400).json({ error: err.message });
    }

    console.error('[delivery-zone-calibration] error inesperado', err);
    return res.status(500).json({ error: 'Error interno calibrando tarifas' });
  }
}
