import { prisma } from "../lib/prisma";

export async function getConversationBotStatus(
  businessId: string,
  conversationId: string
): Promise<{ conversationId: string; botEnabled: boolean } | null> {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      business_id: businessId
    },
    select: { id: true }
  });

  if (!conversation) {
    return null;
  }

  const state = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { is_human_handled: true }
  });

  return {
    conversationId,
    botEnabled: !Boolean(state?.is_human_handled)
  };
}

export async function setConversationBotStatus(
  businessId: string,
  conversationId: string,
  enabled: boolean
): Promise<{ conversationId: string; botEnabled: boolean } | null> {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      business_id: businessId
    },
    select: { id: true }
  });

  if (!conversation) {
    return null;
  }

  await prisma.conversation_state.upsert({
    where: { conversation_id: conversationId },
    create: {
      conversation_id: conversationId,
      is_human_handled: !enabled
    },
    update: {
      is_human_handled: !enabled
    }
  });

  return {
    conversationId,
    botEnabled: enabled
  };
}
