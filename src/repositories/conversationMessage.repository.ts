import { Prisma, type conversation_message } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { emitAdminWhatsappMessageCreated } from '../socket/adminSocket';

export const createConversationMessage = async (
  conversationId: string,
  sender: string,
  message: string,
  isAiGenerated = false,
  externalMessageId?: string,
  whatsappMessageId?: string,
  metrics?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    estimatedCostUsd?: number;
  }
): Promise<conversation_message | null> => {
  try {
    const created = await prisma.conversation_message.create({
      data: {
        conversation_id: conversationId,
        sender,
        message,
        is_ai_generated: isAiGenerated,
        externalMessageId,
        whatsapp_message_id: whatsappMessageId,
        ai_prompt_tokens: metrics?.promptTokens,
        ai_completion_tokens: metrics?.completionTokens,
        ai_total_tokens: metrics?.totalTokens,
        ai_estimated_cost_usd:
          metrics?.estimatedCostUsd !== undefined
            ? new Prisma.Decimal(metrics.estimatedCostUsd)
            : undefined
      }
    });

    const conversation = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { business_id: true }
    });

    if (conversation?.business_id) {
      emitAdminWhatsappMessageCreated(conversation.business_id, {
        conversationId,
        messageId: created.id,
        sender: created.sender,
        message: created.message,
        isAiGenerated: created.is_ai_generated,
        createdAt: created.created_at.toISOString()
      });
    }

    return created;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return null;
    }

    throw error;
  }
};

export const findByWhatsappMessageId = async (
  whatsappMessageId: string
): Promise<conversation_message | null> => {
  return prisma.conversation_message.findUnique({
    where: { whatsapp_message_id: whatsappMessageId }
  });
};

export const getRecentMessagesByConversationId = async (
  conversationId: string,
  limit: number,
  startedAt?: Date
): Promise<conversation_message[]> => {
  return prisma.conversation_message.findMany({
    where: {
      conversation_id: conversationId,
      ...(startedAt ? { created_at: { gte: startedAt } } : {})
    },
    orderBy: { created_at: 'asc' },
    take: limit
  });
};

/** Últimos mensajes desde el inicio de sesión, más recientes primero (contexto NLP). */
export const findRecentMessagesForDetectionContext = async (
  conversationId: string,
  sinceStartedAt: Date,
  take: number
): Promise<conversation_message[]> => {
  return prisma.conversation_message.findMany({
    where: {
      conversation_id: conversationId,
      created_at: { gte: sinceStartedAt }
    },
    orderBy: { created_at: 'desc' },
    take
  });
};
