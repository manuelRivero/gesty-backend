/**
 * Resumen de confirmación final del pedido — paso `confirm` del checkout
 * (ADR-0006, `nextCheckoutStep`). Se muestra después de que el cliente elige
 * método de pago y ANTES de crear la orden: sin esto, elegir "efectivo"
 * disparaba el cobro en el mismo paso, sin que el cliente viera el total
 * real (con envío y ajuste de pago incluidos) ni tuviera forma de arrepentirse.
 *
 * Misma fuente de precios que `get_cart` (`computeOrderPricing`,
 * `resolveDeliveryContext`, `resolvePaymentAdjustment`) — un solo cálculo,
 * no una copia aparte que pueda desincronizarse del total que se cobra
 * de verdad al crear la orden (`checkout.service.ts`).
 */

import { prisma } from '../../lib/prisma';
import { computeOrderPricing } from '../pricing.service';
import { resolveDeliveryContext } from '../deliveryFee.service';
import { resolvePaymentAdjustment } from '../paymentAdjustment.service';
import { formatBotUserMessage } from '../productQuery/utils';
import type { WhatsAppInteractiveMessage } from '../../domain/intent/whatsappTemplates';

const PAYMENT_METHOD_LABEL: Record<'cash' | 'online', string> = {
  cash: 'Efectivo al recibir',
  online: 'Pago online',
};

export interface OrderConfirmationSummary {
  /** `null` si no hay carrito activo (no debería pasar en este paso, defensivo). */
  message: WhatsAppInteractiveMessage | null;
}

export const buildOrderConfirmationMessage = async (params: {
  businessId: string;
  customerId: string;
  customerPhone: string;
  paymentMethod: 'cash' | 'online';
  currencyCode: string | null;
  /** Texto de una respuesta lateral a anteponer (retomar tras interrupción, H-03). */
  leadingText?: string;
}): Promise<WhatsAppInteractiveMessage | null> => {
  const { businessId, customerId, customerPhone, paymentMethod, currencyCode, leadingText } = params;

  const draft = await prisma.draft_order.findFirst({
    where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
    include: {
      draft_order_item: { include: { menu_item: { select: { name: true } } } },
    },
  });

  if (!draft || draft.draft_order_item.length === 0) return null;

  const deliveryCtx = await resolveDeliveryContext({
    customerId,
    businessId,
    fulfillmentType: draft.fulfillment_type,
  });

  const pricingBeforeAdjustment = computeOrderPricing(draft.draft_order_item, {
    deliveryFee: deliveryCtx.deliveryFee,
  });

  const adjustment = await resolvePaymentAdjustment({
    businessId,
    paymentMethod,
    baseAmount: pricingBeforeAdjustment.total,
  });

  const pricing = computeOrderPricing(draft.draft_order_item, {
    deliveryFee: deliveryCtx.deliveryFee,
    paymentAdjustment: adjustment.adjustmentAmount,
  });

  const itemLines = draft.draft_order_item.map(
    (it) => `${it.quantity}× ${it.menu_item?.name ?? 'Producto'}`
  );

  const lines: string[] = [...itemLines, ''];
  lines.push(`Subtotal: $${(pricing.subtotal - pricing.productDiscounts).toFixed(2)}`);
  if (pricing.deliveryFee > 0) {
    lines.push(`Envío: $${pricing.deliveryFee.toFixed(2)}`);
  }
  if (adjustment.hasAdjustment) {
    const sign = adjustment.adjustmentAmount > 0 ? '+' : '−';
    lines.push(
      `${adjustment.label ?? 'Ajuste por método de pago'}: ${sign}$${Math.abs(adjustment.adjustmentAmount).toFixed(2)}`
    );
  }
  lines.push(`*Total: $${pricing.total.toFixed(2)} ${currencyCode ?? 'ARS'}*`);
  lines.push('');
  lines.push(`Pago: ${PAYMENT_METHOD_LABEL[paymentMethod]}`);

  const summaryText = formatBotUserMessage('Resumen del pedido', '🧾', lines.join('\n'));

  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Confirmá tu pedido' },
      body: {
        text: leadingText ? `${leadingText}\n\n${summaryText}` : summaryText,
      },
      footer: { text: 'Revisá el total antes de confirmar' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'CONFIRM_ORDER', title: '✅ Confirmar pedido' } },
          { type: 'reply', reply: { id: 'EDIT_PAYMENT_METHOD', title: '❌ Cancelar' } },
        ],
      },
    },
  } as WhatsAppInteractiveMessage;
};
