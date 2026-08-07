import { OrderStatus } from "@prisma/client";
import {
  createConversationMessage,
  updateConversationLastMessageAt
} from "../repositories";
import type { AdminPatchableOrderStatus } from "../constants/orderWorkflow";
import { ORDER_STATUS_LABEL_ES } from "../constants/orderWorkflow";
import { prisma } from "../lib/prisma";
import { WhatsAppSenderService } from "./whatsappSender.service";
import { formatBotUserMessage } from "./productQuery/utils";

export function shortOrderRef(orderId: string): string {
  return orderId.replace(/-/g, "").slice(0, 8).toUpperCase();
}

/**
 * Mensaje al cliente (mismo estilo que el bot: 🤖, negritas con *...*).
 */
export function buildOrderStatusCustomerMessage(
  status: AdminPatchableOrderStatus,
  orderId: string
): string {
  const label = ORDER_STATUS_LABEL_ES[status as OrderStatus];
  const ref = shortOrderRef(orderId);
  switch (status) {
    case OrderStatus.preparing:
      return formatBotUserMessage(
        'Actualización de tu pedido',
        '📦',
        `Pedido *#${ref}*\n\nTu pedido está *${label.toLowerCase()}*. En breve te avisamos el siguiente paso.`
      );
    case OrderStatus.ready_for_pickup:
      return formatBotUserMessage(
        'Actualización de tu pedido',
        '🏪',
        `Pedido *#${ref}*\n\nTu pedido está *listo para retirar*. Podés pasar a buscarlo cuando quieras.`
      );
    case OrderStatus.shipped:
      return formatBotUserMessage(
        'Actualización de tu pedido',
        '🚚',
        `Pedido *#${ref}*\n\nTu pedido está *${label.toLowerCase()}* y va en camino.`
      );
    case OrderStatus.delivered:
      return formatBotUserMessage(
        'Actualización de tu pedido',
        '✅',
        `Pedido *#${ref}*\n\nTu pedido figura como *${label.toLowerCase()}*. ¡Gracias por elegirnos!`
      );
    default:
      return formatBotUserMessage(
        'Actualización de tu pedido',
        '📦',
        `Pedido *#${ref}*\n\nEl estado de tu pedido fue actualizado.`
      );
  }
}

export type NotifyOrderStatusResult = { sent: true } | { sent: false; reason: string };

/**
 * Envía WhatsApp al teléfono del cliente y opcionalmente registra el mensaje
 * en la conversación. Es el primitivo compartido: cualquier notificación
 * saliente al cliente sobre su pedido (cambio de estado, revisión de un
 * comprobante de transferencia — Fase 9 de `PLAN-ACCION-COMPROBANTES-CIERRE.md`)
 * pasa por acá en vez de reimplementar el envío.
 *
 * Fuera de la ventana de 24 h de WhatsApp esto puede fallar (sin Message
 * Templates el envío libre solo funciona dentro de esa ventana — ver brecha
 * de HSM en `PENDING-FEATURES.md`). El fallo se reporta, nunca se lanza:
 * quien llama decide si un envío fallido debe revertir o no la acción que lo
 * disparó.
 */
export async function sendCustomerWhatsAppNotification(params: {
  businessId: string;
  customerPhone: string;
  conversationId: string | null;
  body: string;
  logTag?: string;
}): Promise<NotifyOrderStatusResult> {
  const logTag = params.logTag ?? "OrderStatusNotify";

  const business = await prisma.business.findUnique({
    where: { id: params.businessId },
    select: { whatsapp_phone_id: true, name: true }
  });

  const phoneNumberId = business?.whatsapp_phone_id?.trim();
  if (!phoneNumberId) {
    return {
      sent: false,
      reason: "El negocio no tiene whatsapp_phone_id configurado"
    };
  }

  const sender = new WhatsAppSenderService();

  try {
    await sender.sendTextMessage({
      phoneNumberId,
      to: params.customerPhone,
      message: params.body
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${logTag}] WhatsApp:`, msg);
    return { sent: false, reason: msg };
  }

  if (params.conversationId) {
    try {
      await createConversationMessage(params.conversationId, "ai", params.body, false);
      await updateConversationLastMessageAt(params.conversationId);
    } catch (e) {
      console.error(`[${logTag}] persist mensaje conversación:`, e);
    }
  }

  return { sent: true };
}

/**
 * Envía WhatsApp al teléfono del cliente y opcionalmente registra el mensaje en la conversación.
 */
export async function notifyCustomerOrderStatusFromAdmin(params: {
  businessId: string;
  orderId: string;
  customerPhone: string;
  conversationId: string | null;
  newStatus: AdminPatchableOrderStatus;
}): Promise<NotifyOrderStatusResult> {
  const body = buildOrderStatusCustomerMessage(params.newStatus, params.orderId);
  return sendCustomerWhatsAppNotification({
    businessId: params.businessId,
    customerPhone: params.customerPhone,
    conversationId: params.conversationId,
    body,
    logTag: "OrderStatusNotify"
  });
}
