/**
 * Edición admin del `draft_order` de una conversación escalada a humano.
 *
 * El carrito del bot vive keyed por `business_id + customer_phone`, no por
 * conversación — por eso cada función primero resuelve `conversation →
 * customer/business` y a partir de ahí reutiliza exactamente los mismos
 * helpers/bloques transaccionales que usa el bot (`handleDraftOrder`,
 * `handleDraftOrderItem`, el `$transaction` de add/remove).
 *
 * Gate: solo se puede editar mientras la conversación está en modo humano
 * (`conversation_state.is_human_handled`), que ya es el mismo flag que el
 * switch "Modo humano" del panel. No hace falta un lock nuevo: para editar,
 * el admin ya tuvo que apagar el bot.
 *
 * Esto NO crea la orden directamente: `requestAdminDraftOrderConfirmation`
 * solo le manda al cliente la tarjeta de confirmación (mismo mecanismo que el
 * checkout propio del bot). La orden real recién se crea cuando el cliente
 * toca "Confirmar" — ver `adminOrderConfirmationWebhook.service.ts`, que
 * intercepta ese tap y ahí sí llama a `createOrderFromDraft`
 * (`checkout.service.ts`).
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { handleDraftOrder, handleDraftOrderItem } from './order.service';
import { resolveEffectivePrice } from '../helpers/menuItemPrice.helper';
import { resolveDeliveryContext } from './deliveryFee.service';
import { getBusinessConfig } from './businessConfig.service';
import { listOfferedPaymentMethods } from './paymentMethods.service';
import { resolveCartPromotions, promotionSignature } from './promotions/resolveCartPromotions';
import { buildOrderConfirmationMessage } from './checkout/orderConfirmationMessage';
import { WhatsAppSenderService } from './whatsappSender.service';
import { createConversationMessage } from '../repositories/conversationMessage.repository';
import { patchConversationMetadata } from '../repositories/conversationState.repository';
import { isPaymentMethodId, type PaymentMethodId } from '../domain/payment/paymentMethods';

export class AdminDraftOrderError extends Error {
  constructor(
    public readonly code:
      | 'NOT_FOUND'
      | 'NOT_HUMAN_HANDLED'
      | 'PRODUCT_NOT_FOUND'
      | 'ITEM_NOT_FOUND'
      | 'INVALID_QUANTITY'
      | 'INVALID_FULFILLMENT_TYPE'
      | 'EMPTY_CART'
      | 'NO_ADDRESS'
      | 'OUT_OF_COVERAGE'
      | 'PAYMENT_METHOD_NOT_OFFERED'
      | 'NO_WHATSAPP_CONFIG',
    message: string
  ) {
    super(message);
    this.name = 'AdminDraftOrderError';
  }
}

const MAX_ITEM_QUANTITY = 10;

export type DeliveryCoverageStatus = 'ok' | 'no_address' | 'out_of_coverage' | 'not_applicable';

function formatAddressLine(address: {
  street_address: string;
  apartment: string | null;
  neighborhood: string | null;
  city: string | null;
}): string {
  const parts = [
    address.street_address,
    address.apartment ? `(${address.apartment})` : null,
    address.neighborhood,
    address.city,
  ].filter((part): part is string => Boolean(part && part.trim()));
  return parts.join(', ');
}

/** Resuelve dirección/envío/cobertura del draft para mostrarle al admin antes de mandar nada. */
async function resolveDeliveryInfo(
  businessId: string,
  customerId: string,
  fulfillmentType: string | null
) {
  if (fulfillmentType !== 'DELIVERY') {
    return {
      fulfillmentType,
      deliveryAddress: null as string | null,
      deliveryFee: 0,
      deliveryCoverage: 'not_applicable' as DeliveryCoverageStatus,
    };
  }

  const address = await prisma.customer_address.findFirst({
    where: { customer_id: customerId, is_default: true },
    select: { street_address: true, apartment: true, neighborhood: true, city: true },
  });

  const ctx = await resolveDeliveryContext({ customerId, businessId, fulfillmentType });

  const deliveryCoverage: DeliveryCoverageStatus = !address
    ? 'no_address'
    : !ctx.zoneId
      ? 'out_of_coverage'
      : 'ok';

  return {
    fulfillmentType,
    deliveryAddress: address ? formatAddressLine(address) : null,
    deliveryFee: ctx.deliveryFee,
    deliveryCoverage,
  };
}

/** Resuelve conversation + customer + business para esta conversación/business, verificando el gate de modo humano. */
async function resolveHumanHandledContext(businessId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, business_id: businessId },
    include: { customer: true, business: true },
  });
  if (!conversation) {
    throw new AdminDraftOrderError('NOT_FOUND', 'Conversación no encontrada');
  }

  const state = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { is_human_handled: true },
  });
  if (!state?.is_human_handled) {
    throw new AdminDraftOrderError(
      'NOT_HUMAN_HANDLED',
      'La conversación debe estar en modo humano para editar el pedido'
    );
  }

  return conversation;
}

function recomputeTotalAmount(
  tx: Prisma.TransactionClient,
  draftOrderId: string
): Promise<Prisma.Decimal> {
  return tx.draft_order_item
    .findMany({ where: { draft_order_id: draftOrderId }, select: { total_price: true } })
    .then((items) =>
      items.reduce((acc, item) => acc.add(item.total_price), new Prisma.Decimal(0))
    );
}

export async function getAdminDraftOrder(businessId: string, conversationId: string) {
  const conversation = await resolveHumanHandledContext(businessId, conversationId);
  const { customer, business } = conversation;

  const draft = await handleDraftOrder(business, customer);
  const items = await prisma.draft_order_item.findMany({
    where: { draft_order_id: draft.id },
    include: { menu_item: { select: { id: true, name: true, image: true } } },
    orderBy: { id: 'asc' },
  });

  const delivery = await resolveDeliveryInfo(businessId, customer.id, draft.fulfillment_type);
  const businessConfig = await getBusinessConfig(businessId);
  const offeredPaymentMethods = await listOfferedPaymentMethods(businessId, {
    externalDeliveryEnabled: businessConfig.external_delivery_enabled ?? false,
  });

  return { draft, items, delivery, offeredPaymentMethods };
}

export async function setAdminDraftOrderFulfillment(
  businessId: string,
  conversationId: string,
  fulfillmentType: 'TAKE_AWAY' | 'DELIVERY'
) {
  const conversation = await resolveHumanHandledContext(businessId, conversationId);
  const { customer, business } = conversation;

  if (fulfillmentType !== 'TAKE_AWAY' && fulfillmentType !== 'DELIVERY') {
    throw new AdminDraftOrderError('INVALID_FULFILLMENT_TYPE', 'Modalidad inválida');
  }

  const draft = await handleDraftOrder(business, customer);
  await prisma.draft_order.update({ where: { id: draft.id }, data: { fulfillment_type: fulfillmentType } });

  return getAdminDraftOrder(businessId, conversationId);
}

export async function addAdminDraftOrderItem(
  businessId: string,
  conversationId: string,
  params: { menuItemId: string; quantity?: number; variation?: string | null }
) {
  const conversation = await resolveHumanHandledContext(businessId, conversationId);
  const { customer, business } = conversation;
  const qty = Math.min(MAX_ITEM_QUANTITY, Math.max(1, Math.floor(params.quantity ?? 1)));
  const variation = params.variation ?? null;

  const item = await prisma.menu_item.findFirst({
    where: { id: params.menuItemId, business_id: business.id, is_available: true },
    include: {
      menu_item_price: {
        where: {
          is_active: true,
          valid_from: { lte: new Date() },
          OR: [{ valid_to: null }, { valid_to: { gte: new Date() } }],
        },
        orderBy: { valid_from: 'desc' },
        take: 1,
      },
    },
  });
  if (!item) {
    throw new AdminDraftOrderError('PRODUCT_NOT_FOUND', 'Producto no encontrado o no disponible');
  }

  const draft = await handleDraftOrder(business, customer);
  const resolved = resolveEffectivePrice(item);
  const unitPrice = resolved.finalPrice;

  await prisma.$transaction(async (tx) => {
    const existingItem = await tx.draft_order_item.findFirst({
      where: { draft_order_id: draft.id, product_id: item.id, variation },
    });
    if (existingItem) {
      const newQty = existingItem.quantity + qty;
      await tx.draft_order_item.update({
        where: { id: existingItem.id },
        data: {
          quantity: newQty,
          unit_price: unitPrice,
          total_price: unitPrice.mul(newQty),
          list_price: resolved.hasDiscount ? resolved.listPrice : null,
          discount_amount: resolved.hasDiscount ? resolved.discountAmount : null,
        },
      });
    } else {
      await tx.draft_order_item.create({
        data: {
          draft_order_id: draft.id,
          product_id: item.id,
          quantity: qty,
          unit_price: unitPrice,
          total_price: unitPrice.mul(qty),
          list_price: resolved.hasDiscount ? resolved.listPrice : null,
          discount_amount: resolved.hasDiscount ? resolved.discountAmount : null,
          variation,
        },
      });
    }
    const totalAmount = await recomputeTotalAmount(tx, draft.id);
    await tx.draft_order.update({ where: { id: draft.id }, data: { total_amount: totalAmount } });
  });

  return getAdminDraftOrder(businessId, conversationId);
}

export async function updateAdminDraftOrderItemQuantity(
  businessId: string,
  conversationId: string,
  itemId: string,
  quantity: number
) {
  const conversation = await resolveHumanHandledContext(businessId, conversationId);
  const { customer, business } = conversation;

  if (!Number.isFinite(quantity) || quantity < 1 || quantity > MAX_ITEM_QUANTITY) {
    throw new AdminDraftOrderError(
      'INVALID_QUANTITY',
      `La cantidad debe estar entre 1 y ${MAX_ITEM_QUANTITY}`
    );
  }

  const draft = await handleDraftOrder(business, customer);
  const line = await handleDraftOrderItem(draft, itemId);
  if (!line) {
    throw new AdminDraftOrderError('ITEM_NOT_FOUND', 'Ítem no encontrado en el pedido');
  }

  await prisma.$transaction(async (tx) => {
    await tx.draft_order_item.update({
      where: { id: line.id },
      data: {
        quantity,
        total_price: line.unit_price.mul(quantity),
      },
    });
    const totalAmount = await recomputeTotalAmount(tx, draft.id);
    await tx.draft_order.update({ where: { id: draft.id }, data: { total_amount: totalAmount } });
  });

  return getAdminDraftOrder(businessId, conversationId);
}

export async function removeAdminDraftOrderItem(
  businessId: string,
  conversationId: string,
  itemId: string
) {
  const conversation = await resolveHumanHandledContext(businessId, conversationId);
  const { customer, business } = conversation;

  const draft = await handleDraftOrder(business, customer);
  const line = await handleDraftOrderItem(draft, itemId);
  if (!line) {
    throw new AdminDraftOrderError('ITEM_NOT_FOUND', 'Ítem no encontrado en el pedido');
  }

  await prisma.$transaction(async (tx) => {
    await tx.draft_order_item.delete({ where: { id: line.id } });
    const totalAmount = await recomputeTotalAmount(tx, draft.id);
    await tx.draft_order.update({ where: { id: draft.id }, data: { total_amount: totalAmount } });
  });

  return getAdminDraftOrder(businessId, conversationId);
}

/**
 * Manda al cliente la tarjeta de confirmación (ítems, dirección, envío,
 * total, método de pago) con botones `ADMIN_CONFIRM_ORDER`/`ADMIN_CANCEL_ORDER`.
 * NO crea la orden: eso recién pasa cuando el cliente toca "Confirmar" (ver
 * `adminOrderConfirmationWebhook.service.ts`) — el admin arma el pedido pero
 * el cliente tiene que verlo y aprobarlo, igual que en el checkout del bot.
 */
export async function requestAdminDraftOrderConfirmation(
  businessId: string,
  conversationId: string,
  params: { paymentMethod: string }
) {
  const conversation = await resolveHumanHandledContext(businessId, conversationId);
  const { customer, business } = conversation;

  const draft = await handleDraftOrder(business, customer);
  const items = await prisma.draft_order_item.findMany({
    where: { draft_order_id: draft.id },
  });
  if (items.length === 0) {
    throw new AdminDraftOrderError('EMPTY_CART', 'El pedido no tiene ítems');
  }

  if (!isPaymentMethodId(params.paymentMethod)) {
    throw new AdminDraftOrderError('PAYMENT_METHOD_NOT_OFFERED', 'Método de pago inválido');
  }
  const paymentMethod: PaymentMethodId = params.paymentMethod;

  const businessConfig = await getBusinessConfig(businessId);
  const offeredPaymentMethods = await listOfferedPaymentMethods(businessId, {
    externalDeliveryEnabled: businessConfig.external_delivery_enabled ?? false,
  });
  if (!offeredPaymentMethods.some((m) => m.id === paymentMethod)) {
    throw new AdminDraftOrderError(
      'PAYMENT_METHOD_NOT_OFFERED',
      'Ese método de pago no está habilitado para este negocio'
    );
  }

  const delivery = await resolveDeliveryInfo(businessId, customer.id, draft.fulfillment_type);
  if (delivery.fulfillmentType === 'DELIVERY') {
    if (delivery.deliveryCoverage === 'no_address') {
      throw new AdminDraftOrderError(
        'NO_ADDRESS',
        'El cliente no tiene una dirección cargada para delivery'
      );
    }
    if (delivery.deliveryCoverage === 'out_of_coverage') {
      throw new AdminDraftOrderError(
        'OUT_OF_COVERAGE',
        'La dirección del cliente está fuera de la zona de cobertura'
      );
    }
  }

  const phoneNumberId = business.whatsapp_phone_id?.trim();
  if (!phoneNumberId) {
    throw new AdminDraftOrderError(
      'NO_WHATSAPP_CONFIG',
      'El negocio no tiene WhatsApp configurado'
    );
  }

  // Misma firma de promociones que usa el checkout del bot (D11): si cambian
  // entre que se manda la tarjeta y el cliente confirma, se aborta en vez de
  // cobrar un total que nadie vio.
  const promotions = await resolveCartPromotions({
    businessId,
    draftOrderId: draft.id,
    customerId: customer.id,
    deliveryFee: delivery.deliveryFee,
  });
  const expectedPromotionSignature = promotionSignature(promotions);

  const message = await buildOrderConfirmationMessage({
    businessId,
    customerId: customer.id,
    customerPhone: customer.phone_number,
    paymentMethod,
    currencyCode: business.currency_code ?? null,
    addressLine: delivery.deliveryAddress,
    buttonIds: { confirm: 'ADMIN_CONFIRM_ORDER', cancel: 'ADMIN_CANCEL_ORDER' },
  });
  if (!message) {
    throw new AdminDraftOrderError('EMPTY_CART', 'El pedido no tiene ítems');
  }

  const sender = new WhatsAppSenderService();
  await sender.sendInteractiveMessage({
    phoneNumberId,
    to: customer.phone_number,
    messageObject: message,
  });

  await patchConversationMetadata(conversationId, {
    pendingAction: 'ADMIN_CONFIRM_ORDER',
    pendingAdminCheckout: { paymentMethod, expectedPromotionSignature },
  });

  const summaryText = message.interactive.body.text;
  await createConversationMessage(conversationId, 'ai', summaryText, false);

  return { sent: true as const };
}
