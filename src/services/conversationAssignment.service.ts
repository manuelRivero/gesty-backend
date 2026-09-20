/**
 * Asignación de conversaciones WhatsApp (inbox de equipo, Fase A).
 * No toca `is_human_handled` (D1 / I5).
 */

import { prisma } from "../lib/prisma";
import { emitAdminWhatsappAssignmentUpdated } from "../socket/adminSocket";
import {
  INBOX_ASSIGNABLE_ROLES,
  mapInboxAssignedUser,
  type InboxAssignedUserDto
} from "./conversationInbox.shared";

export type ConversationAssignmentCode =
  | "NOT_FOUND"
  | "NOT_ASSIGNABLE_USER";

export class ConversationAssignmentError extends Error {
  readonly code: ConversationAssignmentCode;

  constructor(code: ConversationAssignmentCode, message: string) {
    super(message);
    this.name = "ConversationAssignmentError";
    this.code = code;
  }
}

async function assertAssignableInboxUser(params: {
  businessId: string;
  businessUserId: string;
}): Promise<void> {
  const row = await prisma.business_user.findFirst({
    where: {
      id: params.businessUserId,
      business_id: params.businessId,
      role: { in: [...INBOX_ASSIGNABLE_ROLES] }
    },
    select: { id: true }
  });

  if (!row) {
    throw new ConversationAssignmentError(
      "NOT_ASSIGNABLE_USER",
      "El usuario indicado no es un miembro asignable del inbox de este negocio"
    );
  }
}

export async function assignConversation(params: {
  businessId: string;
  conversationId: string;
  businessUserId: string | null;
}): Promise<{
  conversationId: string;
  assignedUser: InboxAssignedUserDto | null;
  assignedAt: string | null;
}> {
  const existing = await prisma.conversation.findFirst({
    where: {
      id: params.conversationId,
      business_id: params.businessId
    },
    select: { id: true }
  });

  if (!existing) {
    throw new ConversationAssignmentError(
      "NOT_FOUND",
      "Conversación no encontrada"
    );
  }

  if (params.businessUserId) {
    await assertAssignableInboxUser({
      businessId: params.businessId,
      businessUserId: params.businessUserId
    });
  }

  const assignedAt = params.businessUserId ? new Date() : null;

  const updated = await prisma.conversation.update({
    where: { id: params.conversationId },
    data: {
      assigned_business_user_id: params.businessUserId,
      assigned_at: assignedAt
    },
    select: {
      id: true,
      assigned_at: true,
      assigned_business_user: {
        select: {
          id: true,
          user_id: true,
          role: true,
          app_user: { select: { name: true } }
        }
      }
    }
  });

  const assignedUser = mapInboxAssignedUser(updated.assigned_business_user);
  const assignedAtIso = updated.assigned_at?.toISOString() ?? null;

  emitAdminWhatsappAssignmentUpdated(params.businessId, {
    conversationId: updated.id,
    assignedUser,
    assignedAt: assignedAtIso
  });

  return {
    conversationId: updated.id,
    assignedUser,
    assignedAt: assignedAtIso
  };
}

export async function takeConversation(params: {
  businessId: string;
  conversationId: string;
  actorBusinessUserId: string;
}): Promise<{
  conversationId: string;
  assignedUser: InboxAssignedUserDto | null;
  assignedAt: string | null;
  botEnabled: boolean;
}> {
  const { setConversationHumanHandled } = await import(
    "./conversationHumanHandled.service"
  );

  const assignment = await assignConversation({
    businessId: params.businessId,
    conversationId: params.conversationId,
    businessUserId: params.actorBusinessUserId
  });

  await setConversationHumanHandled({
    conversationId: params.conversationId,
    businessId: params.businessId,
    humanHandled: true,
    reason: "manual"
  });

  return {
    ...assignment,
    botEnabled: false
  };
}
