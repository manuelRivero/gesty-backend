/**
 * Notas internas por conversación (Fase B). Nunca se envían a Meta (I4).
 */

import { prisma } from "../lib/prisma";
import { emitAdminWhatsappNoteCreated } from "../socket/adminSocket";
import {
  mapInboxAssignedUser,
  type InboxNoteDto
} from "./conversationInbox.shared";

export type ConversationNoteCode = "NOT_FOUND" | "NOTE_NOT_FOUND";

export class ConversationNoteError extends Error {
  readonly code: ConversationNoteCode;

  constructor(code: ConversationNoteCode, message: string) {
    super(message);
    this.name = "ConversationNoteError";
    this.code = code;
  }
}

function toNoteDto(row: {
  id: string;
  conversation_id: string;
  body: string;
  created_at: Date;
  created_by_business_user: {
    id: string;
    user_id: string;
    role: string;
    app_user: { name: string | null } | null;
  };
}): InboxNoteDto {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    body: row.body,
    createdAt: row.created_at.toISOString(),
    createdBy: mapInboxAssignedUser(row.created_by_business_user)!
  };
}

const noteInclude = {
  created_by_business_user: {
    select: {
      id: true,
      user_id: true,
      role: true,
      app_user: { select: { name: true } }
    }
  }
} as const;

async function assertConversation(params: {
  businessId: string;
  conversationId: string;
}): Promise<void> {
  const row = await prisma.conversation.findFirst({
    where: {
      id: params.conversationId,
      business_id: params.businessId
    },
    select: { id: true }
  });
  if (!row) {
    throw new ConversationNoteError("NOT_FOUND", "Conversación no encontrada");
  }
}

export async function listConversationNotes(params: {
  businessId: string;
  conversationId: string;
}): Promise<InboxNoteDto[]> {
  await assertConversation(params);
  const rows = await prisma.conversation_note.findMany({
    where: {
      conversation_id: params.conversationId,
      business_id: params.businessId
    },
    orderBy: { created_at: "desc" },
    include: noteInclude
  });
  return rows.map(toNoteDto);
}

export async function createConversationNote(params: {
  businessId: string;
  conversationId: string;
  body: string;
  actorBusinessUserId: string;
}): Promise<InboxNoteDto> {
  await assertConversation(params);

  const created = await prisma.conversation_note.create({
    data: {
      conversation_id: params.conversationId,
      business_id: params.businessId,
      body: params.body,
      created_by_business_user_id: params.actorBusinessUserId
    },
    include: noteInclude
  });

  const dto = toNoteDto(created);
  emitAdminWhatsappNoteCreated(params.businessId, {
    conversationId: params.conversationId,
    note: dto
  });
  return dto;
}

export async function deleteConversationNote(params: {
  businessId: string;
  conversationId: string;
  noteId: string;
}): Promise<void> {
  await assertConversation(params);
  const result = await prisma.conversation_note.deleteMany({
    where: {
      id: params.noteId,
      conversation_id: params.conversationId,
      business_id: params.businessId
    }
  });
  if (result.count === 0) {
    throw new ConversationNoteError("NOTE_NOT_FOUND", "Nota no encontrada");
  }
}
