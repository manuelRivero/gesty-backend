import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { getActiveProvider } from '../../services/payment/paymentProvider.repository';
import { verifyMpWebhookSignature, fetchMpPayment } from '../../services/payment/mercadoPago.service';
import {
  handleApprovedPayment,
  handleRejectedPayment,
} from '../../services/payment/payment.service';
import { sendTextMessageNoCtx } from '../../services/payment/messageHelpers';

export const mercadoPagoWebhookHandler = async (req: Request, res: Response): Promise<void> => {
  // Siempre responder 200 para que MP no reintente indefinidamente
  res.sendStatus(200);

  try {
    const businessId = req.query.business_id as string | undefined;
    if (!businessId) {
      console.warn('[mp-webhook] missing business_id query param');
      return;
    }

    const body = req.body as { type?: string; action?: string; data?: { id?: string | number } };

    // MP envía varios tipos de notificaciones; solo nos interesan los pagos
    if (body.type !== 'payment' && body.action !== 'payment.updated' && body.action !== 'payment.created') {
      return;
    }

    const mpPaymentId = String(body.data?.id ?? '');
    if (!mpPaymentId) return;

    const provider = await getActiveProvider(businessId, 'mercado_pago');
    if (!provider) {
      console.warn('[mp-webhook] no active provider for business', businessId);
      return;
    }

    // Verificar firma si el business tiene webhook_secret configurado
    if (provider.webhookSecret) {
      const valid = verifyMpWebhookSignature(req, provider.webhookSecret);
      if (!valid) {
        console.warn('[mp-webhook] invalid signature for business', businessId);
        return;
      }
    }

    const payment = await fetchMpPayment(mpPaymentId, provider.accessToken);
    const status = payment.status as string;
    const externalReference = payment.external_reference as string | undefined;
    const paymentAsJson = payment as unknown as Prisma.InputJsonValue;

    if (!externalReference) {
      console.warn('[mp-webhook] no external_reference in payment', mpPaymentId);
      return;
    }

    // Buscar el payment_intent por draft_order_id (external_reference)
    const intent = await prisma.payment_intent.findFirst({
      where: {
        draft_order_id: externalReference,
        business_id: businessId,
        status: 'pending',
      },
      orderBy: { created_at: 'desc' },
    });

    if (!intent) {
      console.warn('[mp-webhook] no pending payment_intent for draft', externalReference);
      return;
    }

    if (status === 'approved') {
      await handleApprovedPayment(intent.id, mpPaymentId, paymentAsJson);
      console.log('[mp-webhook] payment approved, order created for draft', externalReference);
      return;
    }

    if (status === 'rejected' || status === 'cancelled') {
      await handleRejectedPayment(externalReference, mpPaymentId, status, paymentAsJson);

      // Notificar al cliente que el pago no se completó
      const draft = await prisma.draft_order.findUnique({ where: { id: externalReference } });
      const business = await prisma.business.findUnique({ where: { id: businessId } });
      if (draft && business?.whatsapp_phone_id) {
        await sendTextMessageNoCtx(
          business.whatsapp_phone_id,
          draft.customer_phone,
          '🤖\n\n*Pago no completado* 😕\n\nNo pudimos procesar tu pago. Podés intentar de nuevo con el mismo link o elegir pagar en efectivo.\n\nEscribí *"finalizar pedido"* para ver las opciones.'
        );
      }
      console.log('[mp-webhook] payment', status, 'for draft', externalReference);
      return;
    }

    // pending / in_process: solo actualizar el external_id
    await prisma.payment_intent.update({
      where: { id: intent.id },
      data: { external_id: mpPaymentId, updated_at: new Date() },
    });
    console.log('[mp-webhook] payment status', status, 'for draft', externalReference);
  } catch (err) {
    console.error('[mp-webhook] error processing webhook:', err);
  }
};
