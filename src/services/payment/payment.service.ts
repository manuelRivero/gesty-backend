import QRCode from 'qrcode';
import { OrderPaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { getActiveProvider } from './paymentProvider.repository';
import { createMpPreference, fetchMpPayment } from './mercadoPago.service';
import { createOrderFromDraft } from '../checkout.service';
import { emitAdminOrderCreated } from '../../socket/adminSocket';
import { sendTextMessageNoCtx, sendImageMessageNoCtx } from './messageHelpers';
import { formatBotUserMessage } from '../productQuery/utils';
import { computeOrderPricing } from '../pricing.service';
import { resolveDeliveryContext } from '../deliveryFee.service';
import { resolvePaymentAdjustment } from '../paymentAdjustment.service';
import { getBusinessConfig } from '../businessConfig.service';
import { notifyAmbassadorSaleIfNeeded } from '../ambassador/ambassadorSale.service';

export interface PaymentLinkResult {
  initPoint: string;
  preferenceId: string;
  paymentIntentId: string;
  isNew: boolean;
}

/**
 * Devuelve un `payment_intent` activo (pending) existente o crea uno nuevo.
 * Garantiza idempotencia: dos llamadas con el mismo draftOrderId devuelven el mismo link.
 */
export const getOrCreateActiveIntent = async (
  draftOrderId: string,
  businessId: string,
  amount: number,
  currency: string
): Promise<{ id: string; initPoint: string | null; isNew: boolean }> => {
  const existing = await prisma.payment_intent.findFirst({
    where: { draft_order_id: draftOrderId, status: 'pending' },
    orderBy: { created_at: 'desc' },
  });
  if (existing) {
    return { id: existing.id, initPoint: existing.init_point, isNew: false };
  }
  const created = await prisma.payment_intent.create({
    data: {
      business_id: businessId,
      draft_order_id: draftOrderId,
      provider: 'mercado_pago',
      status: 'pending',
      amount,
      currency,
    },
  });
  return { id: created.id, initPoint: null, isNew: true };
};

/** Genera (o reusa) un link de Checkout Pro para el draft_order activo del cliente. */
export const createOnlinePaymentLink = async (
  businessId: string,
  customerPhone: string
): Promise<PaymentLinkResult | null> => {
  const draft = await prisma.draft_order.findFirst({
    where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
    include: { draft_order_item: { include: { menu_item: { include: { menu_item_price: { where: { is_active: true }, take: 1 } } } } } },
  });

  if (!draft || draft.draft_order_item.length === 0) return null;

  const customer = await prisma.customer.findFirst({
    where: { business_id: businessId, phone_number: customerPhone },
    select: { id: true },
  });

  const deliveryCtx = customer
    ? await resolveDeliveryContext({
        customerId: customer.id,
        businessId,
        fulfillmentType: draft.fulfillment_type,
      })
    : { deliveryFee: 0, minOrderAmount: 0, zoneName: null, zoneId: null, estimatedMinutes: null };

  // Para pago online se aplica el ajuste de 'online'
  const pricingBase = computeOrderPricing(draft.draft_order_item, {
    deliveryFee: deliveryCtx.deliveryFee,
  });

  const payAdjCtx = await resolvePaymentAdjustment({
    businessId,
    paymentMethod: 'online',
    baseAmount: pricingBase.total,
  });

  const pricing = computeOrderPricing(draft.draft_order_item, {
    deliveryFee: deliveryCtx.deliveryFee,
    paymentAdjustment: payAdjCtx.adjustmentAmount,
  });
  const currency = draft.currency ?? 'ARS';

  const intent = await getOrCreateActiveIntent(draft.id, businessId, pricing.total, currency);

  if (!intent.isNew && intent.initPoint) {
    return { initPoint: intent.initPoint, preferenceId: '', paymentIntentId: intent.id, isNew: false };
  }

  const provider = await getActiveProvider(businessId, 'mercado_pago');
  if (!provider) return null;

  const items = draft.draft_order_item.map((i) => ({
    id: i.product_id ?? i.id,
    title: i.menu_item?.name ?? 'Producto',
    quantity: i.quantity,
    unit_price: i.unit_price.toNumber(),
    currency_id: currency,
  }));

  // Agregar envío como línea separada en MP si aplica
  if (deliveryCtx.deliveryFee > 0) {
    items.push({
      id: 'delivery_fee',
      title: 'Envío',
      quantity: 1,
      unit_price: deliveryCtx.deliveryFee,
      currency_id: currency,
    });
  }

  // Agregar recargo/descuento por método de pago si aplica
  if (payAdjCtx.hasAdjustment && payAdjCtx.adjustmentAmount !== 0) {
    const adjAmount = Math.abs(payAdjCtx.adjustmentAmount);
    const title = payAdjCtx.adjustmentAmount > 0
      ? (payAdjCtx.label ?? 'Recargo por pago online')
      : (payAdjCtx.label ?? 'Descuento por pago online');
    items.push({
      id: 'payment_adjustment',
      title,
      quantity: 1,
      unit_price: payAdjCtx.adjustmentAmount > 0 ? adjAmount : -adjAmount,
      currency_id: currency,
    });
  }

  const pref = await createMpPreference({
    accessToken: provider.accessToken,
    isSandbox: provider.isSandbox,
    externalReference: draft.id,
    items,
    businessId,
  });

  await prisma.payment_intent.update({
    where: { id: intent.id },
    data: { preference_id: pref.preferenceId, init_point: pref.initPoint, updated_at: new Date() },
  });

  await prisma.draft_order.update({
    where: { id: draft.id },
    data: { payment_method: 'online' },
  });

  return { initPoint: pref.initPoint, preferenceId: pref.preferenceId, paymentIntentId: intent.id, isNew: true };
};

/**
 * Procesa un pago aprobado por el webhook de MP.
 * Crea la orden, actualiza el intent, notifica al admin y al cliente por WhatsApp.
 */
export const handleApprovedPayment = async (
  paymentIntentId: string,
  mpPaymentId: string,
  rawPayload: Prisma.InputJsonValue
): Promise<void> => {
  const intent = await prisma.payment_intent.findUnique({
    where: { id: paymentIntentId },
    include: { draft_order: { include: { business: true } } },
  });

  if (!intent || intent.status === 'approved') return;

  const draft = intent.draft_order;
  if (!draft || draft.status !== 'active') return;

  const business = draft.business;
  if (!business) return;

  const customer = await prisma.customer.findFirst({
    where: { business_id: business.id, phone_number: draft.customer_phone },
  });
  if (!customer) return;

  const conversation = await prisma.conversation.findFirst({
    where: { business_id: business.id, customer_id: customer.id, status: 'open' },
  });
  if (!conversation) return;

  // Transacción: crea orden + actualiza intent
  const { orderId, total, qrDataUrl } = await prisma.$transaction(async () => {
    const { orderId, total, qrDataUrl } = await createOrderFromDraft(
      business,
      conversation,
      customer,
      { paymentStatus: OrderPaymentStatus.paid, paymentMethod: 'online' }
    );

    await prisma.payment_intent.update({
      where: { id: intent.id },
      data: {
        status: 'approved',
        external_id: mpPaymentId,
        order_id: orderId,
        raw_webhook_payload: rawPayload,
        updated_at: new Date(),
      },
    });

    return { orderId, total, qrDataUrl };
  });

  // Fire-and-forget: nunca debe bloquear ni romper la confirmación de pago online.
  void notifyAmbassadorSaleIfNeeded(orderId).catch((err) => {
    console.error('[Payment] Error al notificar venta de embajador (online):', err);
  });

  // Notificar al cliente
  const phoneId = business.whatsapp_phone_id;
  if (phoneId) {
    const businessConfig = await getBusinessConfig(business.id);
    const msg = formatBotUserMessage(
      '¡Pago recibido!',
      '✅',
      `Número: #${orderId}\nTotal: $${total}\nEstado: Confirmado`
    );
    await sendTextMessageNoCtx(phoneId, customer.phone_number, msg);
    if (!businessConfig.external_delivery_enabled) {
      await sendImageMessageNoCtx(phoneId, customer.phone_number, qrDataUrl);
    }
    await sendTextMessageNoCtx(
      phoneId,
      customer.phone_number,
      formatBotUserMessage(
        '¡Gracias!',
        '🙌',
        'Gracias por tu pedido. Te avisaremos por este medio cuando sea despachado.'
      )
    );
  }
};

/** Marca el intent como rechazado/cancelado. */
export const handleRejectedPayment = async (
  draftOrderId: string,
  mpPaymentId: string,
  newStatus: 'rejected' | 'cancelled',
  rawPayload: Prisma.InputJsonValue
): Promise<void> => {
  await prisma.payment_intent.updateMany({
    where: { draft_order_id: draftOrderId, status: 'pending' },
    data: {
      status: newStatus,
      external_id: mpPaymentId,
      raw_webhook_payload: rawPayload,
      updated_at: new Date(),
    },
  });
};

/** Expira intents pendientes de drafts que ya fueron eliminados. */
export const expireOrphanedIntents = async (): Promise<void> => {
  await prisma.payment_intent.updateMany({
    where: {
      status: 'pending',
      draft_order: { status: { in: ['converted', 'expired'] } },
    },
    data: { status: 'expired', updated_at: new Date() },
  });
};
