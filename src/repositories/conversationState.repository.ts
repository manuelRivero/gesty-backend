// repositories/conversationState.repository.ts
import type { conversation_state, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export const findOrCreateConversationState = async (
  conversationId: string
): Promise<conversation_state> => {
  return prisma.conversation_state.upsert({
    where: { conversation_id: conversationId },
    update: {},
    create: { conversation_id: conversationId }
  });
};

export const updateConversationState = async (
  conversationId: string,
  data: Prisma.conversation_stateUpdateInput
): Promise<conversation_state> => {
  return prisma.conversation_state.update({
    where: { conversation_id: conversationId },
    data
  });
};

/** Fusiona `patch` en `metadata` existente sin pisar otras claves (reservas, onboarding, etc.). */
export const patchConversationMetadata = async (
  conversationId: string,
  patch: Record<string, unknown>
): Promise<conversation_state> => {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  const prev =
    row?.metadata &&
    typeof row.metadata === 'object' &&
    !Array.isArray(row.metadata)
      ? { ...(row.metadata as Record<string, unknown>) }
      : {};
  return prisma.conversation_state.update({
    where: { conversation_id: conversationId },
    data: {
      metadata: { ...prev, ...patch } as Prisma.InputJsonValue,
    },
  });
};

export const omitConversationMetadataKeys = async (
  conversationId: string,
  keys: string[]
): Promise<conversation_state> => {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  const prev =
    row?.metadata &&
    typeof row.metadata === 'object' &&
    !Array.isArray(row.metadata)
      ? { ...(row.metadata as Record<string, unknown>) }
      : {};
  for (const k of keys) {
    delete prev[k];
  }
  return prisma.conversation_state.update({
    where: { conversation_id: conversationId },
    data: { metadata: prev as Prisma.InputJsonValue },
  });
};


export const upsertConversationState = async (
  conversationId: string,
  data: Prisma.conversation_stateCreateInput
) => {
  return prisma.conversation_state.upsert({
    where: { conversation_id: conversationId },
    update: data,
    create: data,
  });
};