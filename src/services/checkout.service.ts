// services/checkoutService.ts

import { customer as CustomerType, business as BusinessType, conversation as ConversationType } from '@prisma/client';
import { OrderPaymentStatus, OrderStatus } from '@prisma/client';
import QRCode from 'qrcode';
import { prisma } from '../lib/prisma';
import { closeConversation, createOrGetOpenConversation, findBusinessByPhoneNumberId, findOrCreateConversationState, findOrCreateCustomer } from '../repositories';
import { HandlerFollowUp, WhatsAppWebhookPayload } from '../controllers/webhook/types';


interface CheckoutResult {
    message: string | null;
    followUps?: HandlerFollowUp[];
    errorMessage?: string;
}

export const buildCheckoutMessage = async (
    business: BusinessType,
    conversation: ConversationType,
    customer: CustomerType
): Promise<CheckoutResult> => {

    if (!business) {
        return { message: null, errorMessage: 'No se encontró el negocio' };
    }

    const cart = await prisma.orders.findFirst({
        where: { conversation_id: conversation.id },
        include: { order_item: { include: { menu_item: true } } }
    });

    if (!cart || cart.order_item.length === 0) {
        const errorText = '🤖\n\n*Tu pedido está vacío 🛒*\n\nPodés explorar el menú para empezar tu pedido.';
        return { message: null, errorMessage: errorText };
    }

    const order = await prisma.orders.create({
        data: {
            business_id: business.id,
            customer_id: customer.id,
            conversation_id: conversation.id,
            status: OrderStatus.placed,
            payment_status: OrderPaymentStatus.unpaid,
            total_amount: cart.order_item.reduce((sum, item) => sum + (item.quantity * item.unit_price.toNumber()), 0),
            order_item: {
                create: cart.order_item.map(item => ({
                    menu_item_id: item.menu_item_id,
                    quantity: item.quantity,
                    unit_price: item.unit_price
                }))
            },
            currency_code: business.currency_code ?? 'ARS',
        }
    });

    /**
     * El carrito en WhatsApp vive en `draft_order` (timeouts / recordatorio "pedido en curso").
     * `closeConversation` no lo toca; hay que marcar el borrador como convertido para que el worker
     * no siga enviando recordatorios tras un checkout exitoso.
     */
    await prisma.draft_order.updateMany({
        where: {
            business_id: business.id,
            customer_phone: customer.phone_number,
            status: 'active'
        },
        data: {
            status: 'converted',
            expires_at: null,
            reminder_sent_at: null
        }
    });

    const qrDataUrl = await QRCode.toDataURL(order.id, {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 280
    });

    await closeConversation(conversation.id);

    const messageText = `🤖\n\n✅ *Pedido confirmado*\n\n` +
        `Número: #${order.id}\n` +
        `Total: $${order.total_amount?.toNumber() ?? 0}\n` +
        `Estado: Recibido`;

    const followUps: HandlerFollowUp[] = [
        { type: 'image', dataUrl: qrDataUrl },
        {
            type: 'text',
            message: '¡Gracias por tu pedido! Te avisaremos por este medio cuando tu pedido sea despachado.'
        }
    ];

    return { message: messageText, followUps };
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
        followUps: result.followUps
    };
};