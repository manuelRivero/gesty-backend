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
  EMPTY_CART_BOT_MESSAGE,
  PAYMENT_METHOD_PROMPT_BOT_MESSAGE,
} from './productQuery/botMessages';

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
): Promise<{ orderId: string; total: number; qrDataUrl: string }> => {
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

  const total = draft.draft_order_item.reduce(
    (sum, item) => sum + item.quantity * item.unit_price.toNumber(),
    0
  );

  const order = await prisma.orders.create({
    data: {
      business_id: business.id,
      customer_id: customer.id,
      conversation_id: conversation.id,
      status: OrderStatus.placed,
      payment_status: paymentStatus,
      payment_method: paymentMethod ?? null,
      total_amount: total,
      order_item: {
        create: draft.draft_order_item.map((item) => ({
          menu_item_id: item.product_id!,
          quantity: item.quantity,
          unit_price: item.unit_price,
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
    total: String(total),
    currency: business.currency_code ?? 'ARS',
  });

  const qrDataUrl = await QRCode.toDataURL(order.id, {
    errorCorrectionLevel: 'M',
    margin: 1,
    width: 280,
  });

  return { orderId: order.id, total, qrDataUrl };
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

  // Si ya tiene payment_method asignado, no volvemos a preguntar
  if (draft.payment_method) {
    return { message: null };
  }

  // Mostrar botones de elección de método de pago
  const paymentChoiceMessage = {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: PAYMENT_METHOD_PROMPT_BOT_MESSAGE,
      },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'PAY_ONLINE', title: '💳 Pago online' } },
          { type: 'reply', reply: { id: 'PAY_CASH', title: '💵 Efectivo' } },
        ],
      },
    },
  };

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
    const { orderId, total, qrDataUrl } = await createOrderFromDraft(
      business,
      conversation,
      customer,
      { paymentStatus: OrderPaymentStatus.unpaid, paymentMethod: 'cash' }
    );

    await closeConversation(conversation.id);

    const messageText = buildOrderConfirmedCashMessage({ orderId, total });

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
