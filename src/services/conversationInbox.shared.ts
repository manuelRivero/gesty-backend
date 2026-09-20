import { prisma } from "../lib/prisma";

export type InboxAssignedUserDto = {
  id: string;
  userId: string;
  name: string | null;
  role: string;
};

export type InboxNoteDto = {
  id: string;
  conversationId: string;
  body: string;
  createdAt: string;
  createdBy: InboxAssignedUserDto;
};

const ASSIGNEE_INCLUDE = {
  app_user: { select: { name: true } }
} as const;

export function mapInboxAssignedUser(
  row:
    | {
        id: string;
        user_id: string;
        role: string;
        app_user: { name: string | null } | null;
      }
    | null
    | undefined
): InboxAssignedUserDto | null {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.app_user?.name ?? null,
    role: row.role
  };
}

export async function findBusinessMembership(params: {
  businessId: string;
  userId: string;
}): Promise<{ id: string; role: string } | null> {
  return prisma.business_user.findFirst({
    where: {
      business_id: params.businessId,
      user_id: params.userId
    },
    select: { id: true, role: true }
  });
}

export async function loadAssignedUserDto(
  businessUserId: string | null | undefined
): Promise<InboxAssignedUserDto | null> {
  if (!businessUserId) return null;
  const row = await prisma.business_user.findUnique({
    where: { id: businessUserId },
    select: {
      id: true,
      user_id: true,
      role: true,
      ...ASSIGNEE_INCLUDE
    }
  });
  return mapInboxAssignedUser(row);
}

export const inboxAssigneeSelect = {
  id: true,
  user_id: true,
  role: true,
  app_user: { select: { name: true } }
} as const;

/** Roles que pueden ser assignees del inbox (OWNER/ADMIN). STAFF no usa el chat. */
export const INBOX_ASSIGNABLE_ROLES = ["OWNER", "ADMIN"] as const;
