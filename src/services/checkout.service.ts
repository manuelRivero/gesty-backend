import { customer as CustomerType, business as BusinessType, conversation as ConversationType } from '@prisma/client';
import { OrderPaymentStatus, OrderStatus, Prisma } from '@prisma/client';
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
  EMPTY_CART_BOT_MESSAGE,
} from './productQuery/botMessages';
import { listPaymentAdjustmentsForAmount } from './paymentAdjustment.service';
import { computeOrderPricing, type PricingResult } from './pricing.service';
import { resolveDeliveryContext } from './deliveryFee.service';
import { resolvePaymentAdjustment } from './paymentAdjustment.service';
import { getBusinessConfig } from './businessConfig.service';
import { listOfferedPaymentMethods } from './paymentMethods.service';
import {
  buildPaymentButtonsMessage,
  buildPaymentChoiceBody,
} from './payment/paymentButtons';
import {
  getPaymentMethod,
  isPaymentMethodId,
  paymentMethodLabel,
  type PaymentMethodId,
} from '../domain/payment/paymentMethods';
import { omitConversationMetadataKeys } from '../repositories/conversationState.repository';
import { normalizeMetadata } from './productQuery/utils';
import { isAmbassadorRefExpired } from './ambassador/referralCode';
import {
  promotionSignature,
  resolveCartPromotions,
} from './promotions/resolveCartPromotions';
import type { PromotionEvaluation } from './promotions/promotionEvaluation.types';

export interface CreateOrderFromDraftParams {
  paymentStatus?: OrderPaymentStatus;
  paymentMethod?: string;
  /**
   * Evaluación ya congelada (camino de pago online: se fija al emitir el link,
   * porque el webhook no tiene turno conversacional donde re-confirmar).
   * Si se omite, se evalúa con el `now` de la creación (D13).
   */
  promotionEvaluation?: PromotionEvaluation;
  /**
   * Firma de la evaluación que el cliente confirmó en el resumen. Si al crear
   * la orden ya no coincide, se aborta con `PromotionChangedError` en vez de
   * cobrar un total que nadie aprobó (Constraint de TAXONOMIA §7).
   */
  expectedPromotionSignature?: string;
}

/** La promoción cambió entre el resumen confirmado y la creación (D13). */
export class PromotionChangedError extends Error {
  readonly code = 'PROMOTION_CHANGED';
  constructor() {
    super('Las promociones del pedido cambiaron: hay que reconfirmar el total');
    this.name = 'PromotionChangedError';
  }
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

  // D13: la promoción se evalúa con el `now` de la CREACIÓN de la orden — es el
  // único instante con consecuencia financiera. Si `expectedPromotionSignature`
  // viene del resumen que el cliente confirmó y ya no coincide, no creamos:
  // cobrar un total que nadie aprobó viola el Constraint de TAXONOMIA §7.
  const promotions = params.promotionEvaluation
    ?? (await resolveCartPromotions({
      businessId: business.id,
      draftOrderId: draft.id,
      customerId: customer.id,
      deliveryFee: deliveryCtx.deliveryFee,
    }));

  if (
    params.expectedPromotionSignature &&
    params.expectedPromotionSignature !== promotionSignature(promotions)
  ) {
    throw new PromotionChangedError();
  }

  const effectiveDeliveryFee = promotions.freeShipping ? 0 : deliveryCtx.deliveryFee;

  // Calculamos base (sin ajuste de pago) para usarla como referencia del porcentaje
  const pricingBase = computeOrderPricing(draft.draft_order_item, {
    deliveryFee: effectiveDeliveryFee,
    promotionDiscount: promotions.monetaryDiscount,
  });

  const payAdjCtx = paymentMethod
    ? await resolvePaymentAdjustment({
        businessId: business.id,
        paymentMethod,
        baseAmount: pricingBase.total,
      })
    : { adjustmentAmount: 0, label: null, hasAdjustment: false };

  const pricing = computeOrderPricing(draft.draft_order_item, {
    deliveryFee: effectiveDeliveryFee,
    promotionDiscount: promotions.monetaryDiscount,
    paymentAdjustment: payAdjCtx.adjustmentAmount,
  });

  // Referencia TEMPORAL de Embajador (D.S.): solo se adhiere al pedido si sigue
  // vigente (TTL). Se borra de metadata más abajo para que compras futuras del
  // mismo chat no comisionen automáticamente (ver ambassador/referralCode.ts).
  const conversationStateRow = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversation.id },
    select: { metadata: true },
  });
  const ambassadorRef = normalizeMetadata(conversationStateRow?.metadata).ambassador_ref;
  const ambassadorPublicCode =
    ambassadorRef && !isAmbassadorRefExpired(ambassadorRef.validatedAt)
      ? ambassadorRef.code
      : null;

  const order = await prisma.orders.create({
    data: {
      business_id: business.id,
      customer_id: customer.id,
      conversation_id: conversation.id,
      status: OrderStatus.placed,
      payment_status: paymentStatus,
      payment_method: paymentMethod ?? null,
      total_amount: pricing.total,
      delivery_fee: effectiveDeliveryFee > 0 ? effectiveDeliveryFee : null,
      payment_adjustment: payAdjCtx.hasAdjustment ? payAdjCtx.adjustmentAmount : null,
      // D3: cuánto se descontó. El porqué va en `order_promotion`.
      promotion_discount:
        pricing.promotionDiscount > 0 ? pricing.promotionDiscount : null,
      ambassador_public_code: ambassadorPublicCode,
      order_item: {
        create: [
          ...draft.draft_order_item.map((item) => ({
            menu_item_id: item.product_id!,
            quantity: item.quantity,
            unit_price: item.unit_price,
            list_price: item.list_price ?? undefined,
            discount_amount: item.discount_amount ?? undefined,
            notes: item.notes ?? undefined,
            // Sin esto la variación se pierde justo en el paso que importa: la
            // cocina recibe "1 Pizza" en vez de "1 Pizza (Roquefort)" (D3).
            variation: item.variation ?? undefined,
          })),
          // D3: el regalo se materializa como línea a $0. La cocina TIENE que
          // verlo en el ticket; como nunca se cobró, no aporta a
          // `promotion_discount` (si aportara, se contaría dos veces).
          ...promotions.giftItems.map((gift) => ({
            menu_item_id: gift.productId,
            quantity: gift.quantity,
            unit_price: new Prisma.Decimal(0),
            notes: `Regalo por promoción: ${gift.productName}`,
          })),
        ],
      },
      order_promotion: {
        create: promotions.applied.map((item) => ({
          promotion_id: item.promotionId,
          name_snapshot: item.name,
          // Snapshot obligatorio: `updatePromotion` reemplaza el offer vivo.
          offer_snapshot: item.offerSnapshot as unknown as Prisma.InputJsonValue,
          benefit_type: item.benefitType,
          applied_as:
            item.benefitClass === 'monetary'
              ? 'order_discount'
              : item.benefitClass === 'shipping'
                ? 'free_shipping'
                : 'free_item',
          discount_amount: new Prisma.Decimal(item.monetaryDiscount),
          saving_value: new Prisma.Decimal(item.savingValue),
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

  if (ambassadorRef) {
    await omitConversationMetadataKeys(conversation.id, ['ambassador_ref']).catch((err) => {
      console.error('[Checkout] Error al limpiar ambassador_ref de metadata:', err);
    });
  }

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
      // El mínimo de la zona mide el volumen de compra, no lo que se cobra:
      // se evalúa PRE-promoción (misma base que `cart.subtotal` del DSL).
      const { itemsTotal } = computeOrderPricing(draftItems);

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
  const promotionsForChoice = await resolveCartPromotions({
    businessId: business.id,
    draftOrderId: draft.id,
    customerId: customer.id,
    deliveryFee: deliveryCtxForChoice.deliveryFee,
  });
  const { total: baseTotal } = computeOrderPricing(draftItemsForTotal, {
    deliveryFee: promotionsForChoice.freeShipping ? 0 : deliveryCtxForChoice.deliveryFee,
    promotionDiscount: promotionsForChoice.monetaryDiscount,
  });

  const businessConfig = await getBusinessConfig(business.id);
  const offered = await listOfferedPaymentMethods(business.id, {
    externalDeliveryEnabled: businessConfig.external_delivery_enabled,
  });
  const adjustments = await listPaymentAdjustmentsForAmount({
    businessId: business.id,
    baseAmount: baseTotal,
  });
  const offeredAdjustments = adjustments.filter((a) =>
    offered.some((m) => m.id === a.paymentMethod)
  );

  const paymentChoiceMessage = buildPaymentButtonsMessage(
    buildPaymentChoiceBody(baseTotal, offeredAdjustments),
    offered,
    offeredAdjustments
  );

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

/**
 * Follow-ups post-confirmación unpaid.
 * Transferencia: no decir que el pedido va a despacharse — falta el comprobante
 * y la verificación del admin. El mensaje principal ya invita a mandar la foto.
 */
export function buildUnpaidCheckoutFollowUps(params: {
  qrDataUrl: string;
  includeQr: boolean;
  isBankTransfer: boolean;
}): HandlerFollowUp[] {
  const followUps: HandlerFollowUp[] = [];
  if (params.includeQr) {
    followUps.push({ type: 'image', dataUrl: params.qrDataUrl });
  }
  if (!params.isBankTransfer) {
    followUps.push({
      type: 'text',
      message: buildOrderDispatchThanksMessage(),
    });
  }
  return followUps;
}

/**
 * Checkout unpaid (efectivo o transferencia): crea la orden y confirma.
 * Con delivery externo no se envía el QR (rider sin app propia).
 */
export const buildUnpaidCheckoutResult = async (
  business: BusinessType,
  conversation: ConversationType,
  customer: CustomerType,
  options: {
    paymentMethod: PaymentMethodId;
    externalDeliveryEnabled?: boolean;
    instructions?: string | null;
  }
): Promise<CheckoutResult> => {
  const {
    paymentMethod,
    externalDeliveryEnabled = false,
    instructions = null,
  } = options;

  if (!isPaymentMethodId(paymentMethod)) {
    throw new Error(`invalid_payment_method:${paymentMethod}`);
  }

  const def = getPaymentMethod(paymentMethod);
  const paymentLabel =
    paymentMethod === 'cash'
      ? 'Efectivo al recibir'
      : paymentMethod === 'transfer'
        ? 'Transferencia'
        : paymentMethodLabel(paymentMethod);

  try {
    const { orderId, total, pricing, qrDataUrl } = await createOrderFromDraft(
      business,
      conversation,
      customer,
      { paymentStatus: OrderPaymentStatus.unpaid, paymentMethod }
    );

    await closeConversation(conversation.id);

    const messageText = buildOrderConfirmedCashMessage({
      orderId,
      total,
      deliveryFee: pricing.deliveryFee > 0 ? pricing.deliveryFee : undefined,
      paymentAdjustment: pricing.paymentAdjustment !== 0 ? pricing.paymentAdjustment : undefined,
      paymentLabel,
      instructions: def.collectionKind === 'bank_transfer' ? instructions : null,
      isBankTransfer: def.collectionKind === 'bank_transfer',
    });

    const followUps = buildUnpaidCheckoutFollowUps({
      qrDataUrl,
      includeQr: !externalDeliveryEnabled,
      isBankTransfer: def.collectionKind === 'bank_transfer',
    });

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

/** @deprecated Usar `buildUnpaidCheckoutResult` con paymentMethod: 'cash'. */
export const buildCashCheckoutResult = async (
  business: BusinessType,
  conversation: ConversationType,
  customer: CustomerType,
  options: { externalDeliveryEnabled?: boolean } = {}
): Promise<CheckoutResult> =>
  buildUnpaidCheckoutResult(business, conversation, customer, {
    paymentMethod: 'cash',
    externalDeliveryEnabled: options.externalDeliveryEnabled,
  });
