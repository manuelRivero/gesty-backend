/**
 * Aviso al cliente cuando un admin aprueba o rechaza un comprobante de
 * transferencia (Fase 9, Tarea 9.1 de PLAN-ACCION-COMPROBANTES-CIERRE.md, D9).
 *
 * El bot le prometió al cliente "te avisamos apenas quede confirmado" al
 * recibir el comprobante (`PAYMENT_PROOF_RECEIVED_BOT_MESSAGE`); hasta esta
 * fase esa promesa nunca se cumplía — `reviewAdminPaymentProof` actualizaba
 * la fila y el pago, pero no mandaba nada al cliente.
 *
 * Reutiliza `sendCustomerWhatsAppNotification` (el mismo primitivo que usa
 * `notifyCustomerOrderStatusFromAdmin`) en vez de armar un envío nuevo. Fuera
 * de la ventana de 24 h de WhatsApp esto puede fallar — se reporta, nunca se
 * lanza: la aprobación/rechazo del comprobante ya se persistió antes de
 * llamar acá y no se revierte si el aviso no llega.
 */

import { prisma } from '../lib/prisma';
import {
  sendCustomerWhatsAppNotification,
  type NotifyOrderStatusResult,
} from './orderStatusNotification.service';
import {
  buildPaymentProofApprovedMessage,
  buildPaymentProofRejectedMessage,
} from './productQuery/botMessages';

export async function notifyCustomerPaymentProofReviewed(params: {
  businessId: string;
  orderId: string;
  decision: 'approve' | 'reject';
}): Promise<NotifyOrderStatusResult> {
  const { businessId, orderId, decision } = params;

  const order = await prisma.orders.findFirst({
    where: { id: orderId, business_id: businessId },
    select: { conversation_id: true, customer: { select: { phone_number: true } } },
  });
  if (!order) {
    return { sent: false, reason: 'Orden no encontrada' };
  }

  const body =
    decision === 'approve'
      ? buildPaymentProofApprovedMessage(orderId)
      : buildPaymentProofRejectedMessage(orderId);

  return sendCustomerWhatsAppNotification({
    businessId,
    customerPhone: order.customer.phone_number,
    conversationId: order.conversation_id,
    body,
    logTag: 'PaymentProofNotify',
  });
}
