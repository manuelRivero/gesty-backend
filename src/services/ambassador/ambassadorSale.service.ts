/**
 * Notificación de venta al sistema de Embajadores de Domingo Sabrosón.
 *
 * El agente de WhatsApp no calcula ni decide comisiones (contrato de
 * integración): solo informa que un pedido con `ambassador_public_code`
 * quedó efectivamente PAGADO. Domingo Sabrosón decide si corresponde
 * comisión y responde `commissionCreated: true|false` — ninguno de los dos
 * es un error para el agente.
 *
 * Idempotencia local: `orders.ambassador_notified_at` es el candado que
 * evita notificar dos veces la misma orden (p. ej. aprobar un comprobante y
 * luego marcar el pedido como entregado). Se marca tanto en éxito como en
 * fallo permanente (400/403/404/409); se deja sin marcar en fallos
 * transitorios (401/5xx/timeout) para permitir un reintento futuro.
 *
 * Se invoca siempre "fire and forget" desde los puntos donde `payment_status`
 * pasa a `paid`: un fallo aquí nunca debe romper el cobro.
 */

import { OrderPaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { getBusinessConfig } from '../businessConfig.service';
import {
  isAmbassadorsClientConfigured,
  registerAmbassadorSale,
} from '../../integrations/ambassadors/client';
import { AmbassadorsApiError, AmbassadorsNotConfiguredError } from '../../integrations/ambassadors/types';

const FALLBACK_CUSTOMER_NAME = 'Cliente WhatsApp';

/** Normaliza a E.164 (`+`); en este repo `customer.phone_number` se guarda sin `+`. */
const toE164 = (phone: string): string => (phone.startsWith('+') ? phone : `+${phone}`);

async function markNotified(
  orderId: string,
  result: Prisma.InputJsonValue
): Promise<void> {
  await prisma.orders.update({
    where: { id: orderId },
    data: { ambassador_notified_at: new Date(), ambassador_notify_result: result },
  });
}

/** Fallo permanente: no tiene sentido reintentar (Domingo Sabrosón rechazó el request de raíz). */
const isPermanentFailureStatus = (status: number): boolean =>
  status === 400 || status === 403 || status === 404;

/** `409` = orderId ya notificado del lado de Domingo Sabrosón: éxito idempotente. */
const isAlreadyNotifiedStatus = (status: number): boolean => status === 409;

export async function notifyAmbassadorSaleIfNeeded(orderId: string): Promise<void> {
  try {
    const order = await prisma.orders.findUnique({
      where: { id: orderId },
      include: { customer: { select: { phone_number: true, name: true } } },
    });

    if (!order) return;
    if (!order.ambassador_public_code) return;
    if (order.ambassador_notified_at) return;
    if (order.payment_status !== OrderPaymentStatus.paid) return;

    const businessConfig = await getBusinessConfig(order.business_id);
    if (!businessConfig.ambassadors_enabled) {
      console.log('[AmbassadorSale] ambassadors_enabled=false, no se notifica', { orderId });
      return;
    }

    if (!isAmbassadorsClientConfigured()) {
      console.warn('[AmbassadorSale] AMBASSADORS_API_BASE_URL no configurada, no se notifica', {
        orderId,
      });
      return;
    }

    const payload = {
      publicCode: order.ambassador_public_code,
      orderId: order.id,
      customer: {
        phone: toE164(order.customer.phone_number),
        name: order.customer.name?.trim() || FALLBACK_CUSTOMER_NAME,
      },
      order: {
        total: order.total_amount ? Number(order.total_amount) : 0,
        currency: order.currency_code,
        paidAt: new Date().toISOString(),
      },
    };

    try {
      const response = await registerAmbassadorSale(payload);
      await markNotified(orderId, response as unknown as Prisma.InputJsonValue);
      console.log('[AmbassadorSale] Venta notificada', {
        orderId,
        publicCode: order.ambassador_public_code,
        commissionCreated: response.commissionCreated,
      });
    } catch (err) {
      if (err instanceof AmbassadorsApiError) {
        if (isAlreadyNotifiedStatus(err.status)) {
          await markNotified(orderId, { note: 'already_notified', status: err.status } as Prisma.InputJsonValue);
          return;
        }
        if (isPermanentFailureStatus(err.status)) {
          await markNotified(orderId, {
            error: true,
            status: err.status,
            body: err.body ?? null,
          } as Prisma.InputJsonValue);
          console.error('[AmbassadorSale] Fallo permanente al notificar, no se reintenta', {
            orderId,
            status: err.status,
          });
          return;
        }
        // 401 / 5xx / 502 (timeout/red): transitorio, se deja sin marcar para poder reintentar.
        console.error('[AmbassadorSale] Fallo transitorio al notificar, queda pendiente', {
          orderId,
          status: err.status,
          message: err.message,
        });
        return;
      }
      if (err instanceof AmbassadorsNotConfiguredError) {
        console.warn('[AmbassadorSale] Integración no configurada, queda pendiente', { orderId });
        return;
      }
      throw err;
    }
  } catch (error) {
    // Nunca debe romper el flujo de cobro que la invocó.
    console.error('[AmbassadorSale] Error inesperado, se ignora', { orderId, error });
  }
}
