import { customer as CustomerType, business as BusinessType, conversation as ConversationType } from '@prisma/client';
import { OrderPaymentStatus, OrderStatus } from '@prisma/client';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma';
import {
  closeConversation,
  createOrGetOpenConversation,
  findBusinessByPhoneNumberId,
  findOrCreateConversationState,
  findOrCreateCustomer,
} from '../repositories';
import { HandlerFollowUp, WhatsAppWebhookPayload } from '../controllers/webhook/types';
import { emitAdminOrderCreated } from '../socket/adminSocket';
import {
  buildOrderConfirmedCashMessage,
  buildOrderDispatchThanksMessage,
  buildMinOrderNotMetMessage,
  buildPaymentChoiceMessage,
  EMPTY_CART_BOT_MESSAGE,
} from './productQuery/botMessages';
import { listPaymentAdjustmentsForAmount } from './paymentAdjustment.service';
import { computeOrderPricing, type PricingResult } from './pricing.service';
import { resolveDeliveryContext } from './deliveryFee.service';
import { resolvePaymentAdjustment } from './paymentAdjustment.service';

export interface CreateOrderFromDraftParams {
  paymentStatus?: OrderPaymentStatus;
  paymentMethod?: string;
}

export interface CheckoutResult {
  message: string | null;
  followUps?: HandlerFollowUp[];
  errorMessage?: string;
  orderId?: string;
}

/**
 * Materializa un `draft_order` activo en una `orders` real.
 * Reutilizado tanto por el flujo efectivo (checkout inmediato) como por el webhook
 * de Mercado Pago (pago online confirmado).
 */
export const createOrderFromDraft = async (
  business: BusinessType,
  conversation: ConversationType,
  customer: CustomerType,
  params: CreateOrderFromDraftParams = {}
): Promise<{ orderId: string; total: number; pricing: PricingResult; qrDataUrl: string }> => {
  const { paymentStatus = OrderPaymentStatus.unpaid, paymentMethod } = params;

  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: customer.phone_number,
      status: 'active',
    },
    include: { draft_order_item: { include: { menu_item: true } } },
  });

  if (!draft || draft.draft_order_item.length === 0) {
    throw new Error('empty_cart');
  }

  let customerAddressId: string | undefined;
  let deliveryAddressSnapshot: object = {};
  if (draft.fulfillment_type === 'DELIVERY') {
    const defaultAddress = await prisma.customer_address.findFirst({
      where: { customer_id: customer.id, is_default: true },
    });
    if (defaultAddress) {
      customerAddressId = defaultAddress.id;
      deliveryAddressSnapshot = {
        street_address: defaultAddress.street_address,
        apartment: defaultAddress.apartment,
        neighborhood: defaultAddress.neighborhood,
        city: defaultAddress.city,
        postal_code: defaultAddress.postal_code,
        country: defaultAddress.country,
      };
    }
  }

  const deliveryCtx = await resolveDeliveryContext({
    customerId: customer.id,
    businessId: business.id,
    fulfillmentType: draft.fulfillment_type,
  });

  // Calculamos base (sin ajuste de pago) para usarla como referencia del porcentaje
  const pricingBase = computeOrderPricing(draft.draft_order_item, {
    deliveryFee: deliveryCtx.deliveryFee,
  });

  const payAdjCtx = paymentMethod
    ? await resolvePaymentAdjustment({
        businessId: business.id,
        paymentMethod,
        baseAmount: pricingBase.total,
      })
    : { adjustmentAmount: 0, label: null, hasAdjustment: false };

  const pricing = computeOrderPricing(draft.draft_order_item, {
    deliveryFee: deliveryCtx.deliveryFee,
    paymentAdjustment: payAdjCtx.adjustmentAmount,
  });

  const order = await prisma.orders.create({
    data: {
      business_id: business.id,
      customer_id: customer.id,
      conversation_id: conversation.id,
      status: OrderStatus.placed,
      payment_status: paymentStatus,
      payment_method: paymentMethod ?? null,
      total_amount: pricing.total,
      delivery_fee: deliveryCtx.deliveryFee > 0 ? deliveryCtx.deliveryFee : null,
      payment_adjustment: payAdjCtx.hasAdjustment ? payAdjCtx.adjustmentAmount : null,
      order_item: {
        create: draft.draft_order_item.map((item) => ({
          menu_item_id: item.product_id!,
          quantity: item.quantity,
          unit_price: item.unit_price,
          list_price: item.list_price ?? undefined,
          discount_amount: item.discount_amount ?? undefined,
          notes: item.notes ?? undefined,
        })),
      },
      currency_code: business.currency_code ?? 'ARS',
      fulfillment_type: draft.fulfillment_type ?? undefined,
      customer_address_id: customerAddressId,
      delivery_address_snapshot: deliveryAddressSnapshot,
    },
  });

  await prisma.draft_order.updateMany({
    where: {
      business_id: business.id,
      customer_phone: customer.phone_number,
      status: 'active',
    },
    data: { status: 'converted', expires_at: null, reminder_sent_at: null },
  });

  emitAdminOrderCreated(business.id, {
    orderId: order.id,
    total: String(pricing.total),
    currency: business.currency_code ?? 'ARS',
  });

  const qrDataUrl = await QRCode.toDataURL(order.id, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 280,
  });

  return { orderId: order.id, total: pricing.total, pricing, qrDataUrl };
};

export const buildCheckoutMessage = async (
  business: BusinessType,
  conversation: ConversationType,
  customer: CustomerType
): Promise<CheckoutResult> => {
  if (!business) {
    return { message: null, errorMessage: 'No se encontró el negocio' };
  }

  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: customer.phone_number,
      status: 'active',
    },
  });

  if (!draft || !draft.id) {
    const errorText = EMPTY_CART_BOT_MESSAGE;
    return { message: null, errorMessage: errorText };
  }

  // Validar monto mínimo para DELIVERY
  if (draft.fulfillment_type === 'DELIVERY') {
    const deliveryCtx = await resolveDeliveryContext({
      customerId: customer.id,
      businessId: business.id,
      fulfillmentType: draft.fulfillment_type,
    });

    if (deliveryCtx.minOrderAmount > 0) {
      const draftItems = await prisma.draft_order_item.findMany({
        where: { draft_order_id: draft.id },
        select: { quantity: true, unit_price: true, list_price: true, discount_amount: true },
      });
      const { subtotal, productDiscounts } = computeOrderPricing(draftItems);
      const itemsTotal = subtotal - productDiscounts;

      if (itemsTotal < deliveryCtx.minOrderAmount) {
        const missing = deliveryCtx.minOrderAmount - itemsTotal;
        return {
          message: null,
          errorMessage: buildMinOrderNotMetMessage({
            minOrderAmount: deliveryCtx.minOrderAmount,
            currentAmount: itemsTotal,
            missing,
          }),
        };
      }
    }
  }

  // Si ya tiene payment_method asignado, no volvemos a preguntar
  if (draft.payment_method) {
    return { message: null };
  }

  // Calcular base del total para mostrar precios con ajuste en cada opción
  const draftItemsForTotal = await prisma.draft_order_item.findMany({
    where: { draft_order_id: draft.id },
    select: { quantity: true, unit_price: true, list_price: true, discount_amount: true },
  });
  const deliveryCtxForChoice = await resolveDeliveryContext({
    customerId: customer.id,
    businessId: business.id,
    fulfillmentType: draft.fulfillment_type,
  });
  const { total: baseTotal } = computeOrderPricing(draftItemsForTotal, {
    deliveryFee: deliveryCtxForChoice.deliveryFee,
  });

  const adjustments = await listPaymentAdjustmentsForAmount({
    businessId: business.id,
    baseAmount: baseTotal,
  });

  const paymentChoiceMessage = buildPaymentChoiceMessage(baseTotal, adjustments);

  return { message: 'payment_choice', followUps: [{ type: 'interactive', message: paymentChoiceMessage as any }] };
};

export const handleCheckoutFromWebhook = async (
  payload: WhatsAppWebhookPayload
): Promise<{ content: string; followUps?: HandlerFollowUp[] } | null> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  await findOrCreateConversationState(conversation.id);

  const result = await buildCheckoutMessage(business, conversation, customer);

  if (result.errorMessage) {
    return { content: result.errorMessage };
  }
  if (!result.message) {
    return null;
  }

  return {
    content: result.message,
    followUps: result.followUps,
  };
};

/** Flujo cash: crea la orden inmediatamente y devuelve mensajes de confirmación. */
export const buildCashCheckoutResult = async (
  business: BusinessType,
  conversation: ConversationType,
  customer: CustomerType
): Promise<CheckoutResult> => {
  try {
    const { orderId, total, pricing, qrDataUrl } = await createOrderFromDraft(
      business,
      conversation,
      customer,
      { paymentStatus: OrderPaymentStatus.unpaid, paymentMethod: 'cash' }
    );

    await closeConversation(conversation.id);

    const messageText = buildOrderConfirmedCashMessage({
      orderId,
      total,
      deliveryFee: pricing.deliveryFee > 0 ? pricing.deliveryFee : undefined,
      paymentAdjustment: pricing.paymentAdjustment !== 0 ? pricing.paymentAdjustment : undefined,
    });

    const followUps: HandlerFollowUp[] = [
      { type: 'image', dataUrl: qrDataUrl },
      {
        type: 'text',
        message: buildOrderDispatchThanksMessage(),
      },
    ];

    return { message: messageText, followUps, orderId };
  } catch (err: unknown) {
    if (err instanceof Error && err.message === 'empty_cart') {
      return {
        message: null,
        errorMessage: EMPTY_CART_BOT_MESSAGE,
      };
    }
    throw err;
  }
};
