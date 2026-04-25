import { OrderStatus } from "@prisma/client";
import {
  createConversationMessage,
  updateConversationLastMessageAt
} from "../repositories";
import type { AdminPatchableOrderStatus } from "../constants/orderWorkflow";
import { ORDER_STATUS_LABEL_ES } from "../constants/orderWorkflow";
import { prisma } from "../lib/prisma";
import { WhatsAppSenderService } from "./whatsappSender.service";

function shortOrderRef(orderId: string): string {
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
      return (
        `🤖\n\n*Actualización de tu pedido* 📦\n\n` +
        `Pedido *#${ref}*\n\nTu pedido está *${label.toLowerCase()}*. ` +
        `En breve te avisamos el siguiente paso.`
      );
    case OrderStatus.shipped:
      return (
        `🤖\n\n*Actualización de tu pedido* 🚚\n\n` +
        `Pedido *#${ref}*\n\nTu pedido está *${label.toLowerCase()}* y va en camino.`
      );
    case OrderStatus.delivered:
      return (
        `🤖\n\n*Actualización de tu pedido* ✅\n\n` +
        `Pedido *#${ref}*\n\nTu pedido figura como *${label.toLowerCase()}*. ` +
        `¡Gracias por elegirnos!`
      );
  }
}

export type NotifyOrderStatusResult = { sent: true } | { sent: false; reason: string };

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

  const body = buildOrderStatusCustomerMessage(params.newStatus, params.orderId);
  const sender = new WhatsAppSenderService();

  try {
    await sender.sendTextMessage({
      phoneNumberId,
      to: params.customerPhone,
      message: body
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[OrderStatusNotify] WhatsApp:", msg);
    return { sent: false, reason: msg };
  }

  if (params.conversationId) {
    try {
      await createConversationMessage(params.conversationId, "ai", body, false);
      await updateConversationLastMessageAt(params.conversationId);
    } catch (e) {
      console.error("[OrderStatusNotify] persist mensaje conversación:", e);
    }
  }

  return { sent: true };
}
