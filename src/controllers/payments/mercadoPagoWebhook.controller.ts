import type { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { getActiveProvider } from '../../services/payment/paymentProvider.repository';
import { verifyMpWebhookSignature, fetchMpPayment } from '../../services/payment/mercadoPago.service';
import {
  handleApprovedPayment,
  handleApprovedStorefrontPayment,
  handleRejectedPayment,
  handleRejectedStorefrontPayment,
} from '../../services/payment/payment.service';
import { sendTextMessageNoCtx } from '../../services/payment/messageHelpers';

export const mercadoPagoWebhookHandler = async (req: Request, res: Response): Promise<void> => {
  // Siempre responder 200 para que MP no reintente indefinidamente
  res.sendStatus(200);

  try {
    const businessId = req.query.business_id as string | undefined;
    const body = req.body as { type?: string; action?: string; data?: { id?: string | number } };

    console.log(
      JSON.stringify({
        event: '[mp-debug] webhook_hit',
        businessId: businessId ?? null,
        type: body?.type ?? null,
        action: body?.action ?? null,
        dataId: body?.data?.id ?? null,
        hasSignature: Boolean(req.headers['x-signature']),
      })
    );

    if (!businessId) {
      console.warn(
        JSON.stringify({
          event: '[mp-debug] webhook_skip',
          reason: 'missing_business_id',
        })
      );
      return;
    }

    // MP envía varios tipos de notificaciones; solo nos interesan los pagos
    if (body.type !== 'payment' && body.action !== 'payment.updated' && body.action !== 'payment.created') {
      console.log(
        JSON.stringify({
          event: '[mp-debug] webhook_skip',
          reason: 'ignored_type',
          type: body.type ?? null,
          action: body.action ?? null,
          businessId,
        })
      );
      return;
    }

    const mpPaymentId = String(body.data?.id ?? '');
    if (!mpPaymentId) {
      console.warn(
        JSON.stringify({
          event: '[mp-debug] webhook_skip',
          reason: 'missing_payment_id',
          businessId,
        })
      );
      return;
    }

    const provider = await getActiveProvider(businessId, 'mercado_pago');
    if (!provider) {
      console.warn(
        JSON.stringify({
          event: '[mp-debug] webhook_skip',
          reason: 'no_active_provider',
          businessId,
        })
      );
      return;
    }

    // Verificar firma si el business tiene webhook_secret configurado
    if (provider.webhookSecret) {
      const valid = verifyMpWebhookSignature(req, provider.webhookSecret);
      if (!valid) {
        console.warn(
          JSON.stringify({
            event: '[mp-debug] webhook_skip',
            reason: 'invalid_signature',
            businessId,
            mpPaymentId,
          })
        );
        return;
      }
    }

    const payment = await fetchMpPayment(mpPaymentId, provider.accessToken);
    const status = payment.status as string;
    const externalReference = payment.external_reference as string | undefined;
    const paymentAsJson = payment as unknown as Prisma.InputJsonValue;

    console.log(
      JSON.stringify({
        event: '[mp-debug] webhook_payment_fetched',
        businessId,
        mpPaymentId,
        status,
        externalReference: externalReference ?? null,
      })
    );

    if (!externalReference) {
      console.warn(
        JSON.stringify({
          event: '[mp-debug] webhook_skip',
          reason: 'no_external_reference',
          businessId,
          mpPaymentId,
        })
      );
      return;
    }

    // Draft (WA): draft_order_id = external_reference.
    // Storefront (PAY-06): order_id = external_reference.
    const intent = await prisma.payment_intent.findFirst({
      where: {
        business_id: businessId,
        status: 'pending',
        OR: [
          { order_id: externalReference },
          { draft_order_id: externalReference },
        ],
      },
      orderBy: { created_at: 'desc' },
    });

    if (!intent) {
      console.warn(
        JSON.stringify({
          event: '[mp-debug] webhook_skip',
          reason: 'no_pending_intent',
          businessId,
          mpPaymentId,
          externalReference,
        })
      );
      return;
    }

    const isStorefront = Boolean(intent.order_id);
    console.log(
      JSON.stringify({
        event: '[mp-debug] webhook_intent_matched',
        businessId,
        mpPaymentId,
        externalReference,
        paymentIntentId: intent.id,
        isStorefront,
        orderId: intent.order_id ?? null,
        draftOrderId: intent.draft_order_id ?? null,
        status,
      })
    );

    if (status === 'approved') {
      if (isStorefront) {
        await handleApprovedStorefrontPayment(intent.id, mpPaymentId, paymentAsJson);
        console.log(
          JSON.stringify({
            event: '[mp-debug] webhook_approved_storefront',
            businessId,
            mpPaymentId,
            orderId: externalReference,
            paymentIntentId: intent.id,
          })
        );
      } else {
        await handleApprovedPayment(intent.id, mpPaymentId, paymentAsJson);
        console.log(
          JSON.stringify({
            event: '[mp-debug] webhook_approved_draft',
            businessId,
            mpPaymentId,
            draftOrderId: externalReference,
            paymentIntentId: intent.id,
          })
        );
      }
      return;
    }

    if (status === 'rejected' || status === 'cancelled') {
      if (isStorefront) {
        await handleRejectedStorefrontPayment(
          intent.order_id!,
          mpPaymentId,
          status,
          paymentAsJson
        );
        console.log(
          JSON.stringify({
            event: '[mp-debug] webhook_rejected_storefront',
            businessId,
            mpPaymentId,
            orderId: externalReference,
            status,
          })
        );
        return;
      }

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
      console.log(
        JSON.stringify({
          event: '[mp-debug] webhook_rejected_draft',
          businessId,
          mpPaymentId,
          draftOrderId: externalReference,
          status,
        })
      );
      return;
    }

    // pending / in_process: solo actualizar el external_id
    await prisma.payment_intent.update({
      where: { id: intent.id },
      data: { external_id: mpPaymentId, updated_at: new Date() },
    });
    console.log(
      JSON.stringify({
        event: '[mp-debug] webhook_status_pendingish',
        businessId,
        mpPaymentId,
        externalReference,
        status,
        paymentIntentId: intent.id,
      })
    );
  } catch (err) {
    console.error('[mp-webhook] error processing webhook:', err);
  }
};
