/**
 * Semántica única de bot ON/OFF por conversación (= `is_human_handled`).
 * Al pasar a bot ON limpia assignee (D6) y emite sockets de assignment.
 */

import { prisma } from "../lib/prisma";
import {
  findOrCreateConversationState,
  updateConversationState
} from "../repositories/conversationState.repository";
import {
  emitAdminWhatsappAssignmentUpdated,
  emitAdminWhatsappBotAutoReactivated
} from "../socket/adminSocket";

export async function clearConversationAssignee(params: {
  businessId: string;
  conversationId: string;
  emit?: boolean;
}): Promise<void> {
  await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      assigned_business_user_id: null,
      assigned_at: null
    }
  });

  if (params.emit !== false) {
    emitAdminWhatsappAssignmentUpdated(params.businessId, {
      conversationId: params.conversationId,
      assignedUser: null,
      assignedAt: null
    });
  }
}

/**
 * Flip de modo humano/bot. `humanHandled=false` ⇒ bot ON y clear assignee (D6).
 */
export async function setConversationHumanHandled(params: {
  conversationId: string;
  businessId: string;
  humanHandled: boolean;
  /**
   * Emite `whatsapp.bot_auto_reactivated` (el panel vuelve el switch a "Bot
   * activo" solo y manda el mensaje de reenganche al cliente) para cualquier
   * reactivación que no sea un toggle manual del admin — worker de timeout
   * (`auto_timeout`) o, tras confirmar un pedido admin-initiated
   * (`order_confirmed`, ver `adminOrderConfirmationWebhook.service.ts`): una
   * vez que el cliente confirmó, la gestión puntual del admin terminó y no
   * tiene sentido dejarlo "hablando con nadie" en modo humano.
   */
  reason?: "manual" | "auto_timeout" | "order_confirmed";
}): Promise<void> {
  const { conversationId, businessId, humanHandled, reason = "manual" } =
    params;
  const isAutomaticReactivation = reason === "auto_timeout" || reason === "order_confirmed";

  await findOrCreateConversationState(conversationId);
  await updateConversationState(conversationId, {
    is_human_handled: humanHandled,
    updated_at: new Date()
  });

  if (!humanHandled) {
    const before = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { assigned_business_user_id: true }
    });

    if (before?.assigned_business_user_id) {
      await clearConversationAssignee({ businessId, conversationId });
    } else if (isAutomaticReactivation) {
      // Igual emitir assignment null por si el panel tenía stale state
      emitAdminWhatsappAssignmentUpdated(businessId, {
        conversationId,
        assignedUser: null,
        assignedAt: null
      });
    }

    if (isAutomaticReactivation) {
      emitAdminWhatsappBotAutoReactivated(businessId, { conversationId });
    }
  }
}

export async function markSupportRequested(conversationId: string): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: {
      support_requested_at: new Date(),
      support_acked_at: null,
      support_acked_by_business_user_id: null
    }
  });
}
