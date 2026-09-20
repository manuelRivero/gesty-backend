import { prisma } from "../lib/prisma";
import { createConversationMessage, updateConversationLastMessageAt } from "../repositories";
import { WhatsAppSenderService } from "./whatsappSender.service";
import { setConversationHumanHandled } from "./conversationHumanHandled.service";

export async function sendAdminWhatsappReply(params: {
  businessId: string;
  conversationId: string;
  message: string;
  adminUserId: string;
  /** No forzar is_human_handled (mensajes de sistema al reactivar bot, etc.). */
  skipHumanTakeover?: boolean;
}) {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: params.conversationId,
      business_id: params.businessId
    },
    include: {
      business: {
        select: {
          whatsapp_phone_id: true
        }
      },
      customer: {
        select: {
          phone_number: true
        }
      }
    }
  });

  if (!conversation) {
    return { ok: false as const, reason: "NOT_FOUND" as const };
  }

  if (!conversation.business.whatsapp_phone_id) {
    return { ok: false as const, reason: "BUSINESS_WITHOUT_WHATSAPP_PHONE_ID" as const };
  }

  const sender = new WhatsAppSenderService();
  await sender.sendTextMessage({
    phoneNumberId: conversation.business.whatsapp_phone_id,
    to: conversation.customer.phone_number,
    message: params.message
  });

  await createConversationMessage(
    conversation.id,
    `admin:${params.adminUserId}`,
    params.message,
    false,
    undefined,
    undefined,
    undefined,
    params.adminUserId
  );
  await updateConversationLastMessageAt(conversation.id);

  if (!params.skipHumanTakeover) {
    await setConversationHumanHandled({
      conversationId: conversation.id,
      businessId: params.businessId,
      humanHandled: true,
      reason: "manual"
    });
  }

  return { ok: true as const };
}
