import { sendListResponseNoContext, sendResponseNoContext } from '../controllers/webhook/sender';
import { prisma } from '../lib/prisma';
import { getBusinessConfig } from '../services/businessConfig.service';
import { workerTextMessages } from './textMessages';
import { buildListMessageFromButtons } from '../whatsappBuilders';
import { expireOrphanedIntents } from '../services/payment/payment.service';
import { clearCheckoutSession } from '../graph/nodes/checkout';
import { normalizeMetadata } from '../services/productQuery/utils';

// Ventana de gracia (H-04): si hubo actividad del usuario dentro de este margen
// y el checkout sigue activo, se difiere la expiración un ciclo más en vez de
// borrar el draft. `touchSession` ya extiende `expires_at` en cada turno
// (incluidas las interrupciones delegadas), así que esto es una defensa
// adicional ante una corrida del cron justo en el medio de un turno en curso.
const RECENT_ACTIVITY_GRACE_MS = 60_000;

export const processDraftOrderTimeouts = async () => {

    const now = new Date();

    const orders = await prisma.draft_order.findMany({
        where: {
            status: 'active',
            expires_at: { not: null }
        }
    });

    for (const order of orders) {

        if (!order.expires_at) continue;

        const openConversation = await prisma.conversation.findFirst({
            where: {
                business_id: order.business_id!,
                status: 'open',
                customer: { phone_number: order.customer_phone }
            },
            include: {
                conversation_state: {
                    select: { is_human_handled: true, metadata: true }
                }
            }
        });

        const isHumanHandled = Boolean(
            openConversation?.conversation_state?.is_human_handled
        );
        if (isHumanHandled) {
            continue;
        }

        const remainingMs = order.expires_at.getTime() - now.getTime();
        const remainingMinutes = remainingMs / 60000;

        if (remainingMinutes <= 0) {
            const wsMeta = normalizeMetadata(openConversation?.conversation_state?.metadata);
            const msSinceLastMessage = openConversation
                ? now.getTime() - openConversation.last_message_at.getTime()
                : Infinity;
            if (wsMeta.checkout_active === true && msSinceLastMessage < RECENT_ACTIVITY_GRACE_MS) {
                console.log('[DraftOrderTimeout] Actividad reciente con checkout activo, difiriendo expiración', order.id);
                continue;
            }
        }

        const business = await prisma.business.findUnique({
            where: { id: order.business_id! }
        });

        if (!business) continue;
        const cfg = await getBusinessConfig(business.id);

        /**
         * Reminder
         */
        if (
            cfg.send_order_reminders &&
            remainingMinutes <= cfg.draft_order_reminder_minutes &&
            remainingMinutes > 0 &&
            !order.reminder_sent_at
        ) {
            console.log('Sending reminder for draft order', order.id);
            const listMessage = buildListMessageFromButtons(
                workerTextMessages.draftOrderReminderListBody(cfg.draft_order_reminder_minutes),
                [
                    {
                        title: 'Seguir comprando',
                        payload: 'VIEW_MENU',
                        description: 'Explorar más platos',
                        sectionTitle: 'Opciones'
                    },
                    {
                        title: 'Finalizar pedido',
                        payload: 'CHECKOUT',
                        description: 'Ir al checkout',
                        sectionTitle: 'Opciones'
                    },
                    {
                        title: 'Modificar pedido',
                        payload: 'VIEW_CART_FOR_EDITION',
                        description: 'Editar items del pedido',
                        sectionTitle: 'Opciones'
                        },
                        {
                            title: 'Cancelar pedido',
                            payload: 'CANCEL_ORDER',
                            description: 'Eliminar el pedido actual',
                            sectionTitle: 'Opciones'
                    }
                ],
                'Ver opciones',
                '',
                'Seleccioná una opción para continuar'
            );

            await sendListResponseNoContext(
                business.whatsapp_phone_id!,
                order.customer_phone,
                listMessage
            );

            await prisma.draft_order.update({
                where: { id: order.id },
                data: { reminder_sent_at: new Date() }
            });

            continue;
        }

        /**
         * Expiration
         */
        if (remainingMinutes <= 0) {

            // Eliminar todos los payment_intents del draft antes de borrarlo
            // (updateMany solo sobre 'pending' dejaba otros estados con FK activa)
            await prisma.payment_intent.deleteMany({
                where: { draft_order_id: order.id }
            });

            await prisma.draft_order_item.deleteMany({
                where: { draft_order_id: order.id }
            });

            await prisma.draft_order.delete({
                where: { id: order.id }
            });

            const expiredListMessage = buildListMessageFromButtons(
                workerTextMessages.draftOrderExpiredListBody,
                [
                    {
                        title: 'Ver menú',
                        payload: 'VIEW_MENU',
                        description: 'Explorar platos disponibles',
                        sectionTitle: 'Opciones'
                    },
                    {
                        title: 'Hacer una consulta',
                        payload: 'ASK_QUESTION',
                        description: 'Resolver una duda',
                        sectionTitle: 'Opciones'
                    }
                ],
                'Ver opciones',
                '',
                'Seleccioná una opción para continuar'
            );

            await sendListResponseNoContext(
                business.whatsapp_phone_id!,
                order.customer_phone,
                expiredListMessage
            );

            /**
             * limpiar estado de conversación
             */
            const conversation = await prisma.conversation.findFirst({
                where: {
                    business_id: order.business_id!,
                    customer: {
                        phone_number: order.customer_phone
                    },
                    status: 'open'
                }
            });

            if (conversation) {
                // Solo se limpian las claves del pedido: el draft expiró, no el resto
                // de la conversación. Preserva `reservation_draft`, `onboarding_step`,
                // pendings de otros flujos y demás checkpoints ajenos al carrito (H-04).
                try {
                    await clearCheckoutSession(conversation.id);
                } catch (err) {
                    console.error('[DraftOrderTimeout] error limpiando metadata de checkout:', err);
                }
            }

        }

    }

    /**
     * Conversaciones inactivas (sin importar si hay pedido)
     */
    const openConversations = await prisma.conversation.findMany({
        where: {
            status: 'open',
            OR: [
                { conversation_state: null },
                { conversation_state: { is_human_handled: false } }
            ]
        },
        include: {
            business: true,
            customer: true
        }
    });

    for (const conversation of openConversations) {
        if (!conversation.business?.whatsapp_phone_id || !conversation.customer?.phone_number) continue;
        const cfg = await getBusinessConfig(conversation.business.id);

        const reminderThreshold = new Date(now.getTime() - cfg.idle_reminder_minutes * 60000);
        const expireThreshold = new Date(now.getTime() - cfg.idle_close_minutes * 60000);

        const shouldRemind =
            cfg.send_idle_reminders &&
            !conversation.idle_reminder_sent_at &&
            !conversation.idle_closed_at &&
            conversation.last_message_at <= reminderThreshold;

        const shouldClose =
            !conversation.idle_closed_at &&
            conversation.last_message_at <= expireThreshold;

        if (shouldRemind) {
        console.log('[IdleReminder] Sending to', {
            businessPhoneId: conversation.business.whatsapp_phone_id,
            to: conversation.customer.phone_number,
            conversationId: conversation.id
        });
        const idleReminderList = buildListMessageFromButtons(
            workerTextMessages.conversationIdleReminderListBody(cfg.idle_close_minutes),
            [
                {
                    title: 'Ver menú',
                    payload: 'VIEW_MENU',
                    description: 'Explorar platos disponibles',
                    sectionTitle: 'Opciones'
                },
                {
                    title: 'Ver horarios',
                    payload: 'BUSINESS_HOURS',
                    description: 'Horarios de atención',
                    sectionTitle: 'Opciones'
                },
                {
                    title: 'Hacer una consulta',
                    payload: 'ASK_QUESTION',
                    description: 'Resolver una duda',
                    sectionTitle: 'Opciones'
                },
                {
                    title: 'Necesito ayuda',
                    payload: 'SUPPORT',
                    description: 'Contactar soporte',
                    sectionTitle: 'Opciones'
                }
            ],
            'Ver opciones',
            '🤖\n\n*Recordatorio*',
            'Seleccioná una opción para continuar'
        );

        await sendListResponseNoContext(
            conversation.business.whatsapp_phone_id,
            conversation.customer.phone_number,
            idleReminderList
        );
        await prisma.conversation.update({
            where: { id: conversation.id },
            data: { idle_reminder_sent_at: now }
        });
        }
        if (!shouldClose) continue;
        await sendResponseNoContext(
            conversation.business.whatsapp_phone_id,
            conversation.customer.phone_number,
            workerTextMessages.conversationIdleClosed
        );
        await prisma.conversation.update({
            where: { id: conversation.id },
            data: {
                status: 'closed',
                idle_closed_at: now,
                lastReferencedProductId: null
            }
        });
        await resetConversationState(conversation.id);
    }

};

const resetConversationState = async (conversationId: string) => {
    await prisma.conversation_state.upsert({
        where: { conversation_id: conversationId },
        update: {
            mode: 'GLOBAL',
            metadata: {}
        },
        create: {
            conversation_id: conversationId,
            mode: 'GLOBAL',
            metadata: {}
        }
    });
};