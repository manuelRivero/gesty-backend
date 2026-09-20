/**
 * Ack durable de `support_requested` (I7).
 */

import { prisma } from "../lib/prisma";
import { emitAdminWhatsappSupportAcked } from "../socket/adminSocket";
import {
  loadAssignedUserDto,
  type InboxAssignedUserDto
} from "./conversationInbox.shared";

export type SupportAckCode = "NOT_FOUND";

export class SupportAckError extends Error {
  readonly code: SupportAckCode;

  constructor(code: SupportAckCode, message: string) {
    super(message);
    this.name = "SupportAckError";
    this.code = code;
  }
}

export async function ackConversationSupport(params: {
  businessId: string;
  conversationId: string;
  actorBusinessUserId: string;
}): Promise<{
  conversationId: string;
  supportRequestedAt: string | null;
  supportAckedAt: string;
  ackedBy: InboxAssignedUserDto | null;
  alreadyAcked: boolean;
}> {
  const row = await prisma.conversation.findFirst({
    where: {
      id: params.conversationId,
      business_id: params.businessId
    },
    select: {
      id: true,
      support_requested_at: true,
      support_acked_at: true,
      support_acked_by_business_user_id: true
    }
  });

  if (!row) {
    throw new SupportAckError("NOT_FOUND", "Conversación no encontrada");
  }

  if (row.support_acked_at) {
    const ackedBy = await loadAssignedUserDto(
      row.support_acked_by_business_user_id
    );
    return {
      conversationId: row.id,
      supportRequestedAt: row.support_requested_at?.toISOString() ?? null,
      supportAckedAt: row.support_acked_at.toISOString(),
      ackedBy,
      alreadyAcked: true
    };
  }

  const now = new Date();
  const updated = await prisma.conversation.update({
    where: { id: row.id },
    data: {
      support_acked_at: now,
      support_acked_by_business_user_id: params.actorBusinessUserId,
      // Si nunca hubo request formal, igual dejamos marca para consistencia UI
      support_requested_at: row.support_requested_at ?? now
    },
    select: {
      id: true,
      support_requested_at: true,
      support_acked_at: true,
      support_acked_by_business_user_id: true
    }
  });

  const ackedBy = await loadAssignedUserDto(
    updated.support_acked_by_business_user_id
  );
  const supportAckedAt = updated.support_acked_at!.toISOString();

  emitAdminWhatsappSupportAcked(params.businessId, {
    conversationId: updated.id,
    ackedBy,
    at: supportAckedAt
  });

  return {
    conversationId: updated.id,
    supportRequestedAt: updated.support_requested_at?.toISOString() ?? null,
    supportAckedAt,
    ackedBy,
    alreadyAcked: false
  };
}
