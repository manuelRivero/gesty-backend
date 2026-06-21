import { Prisma, type conversation } from '@prisma/client';
import { prisma } from '../lib/prisma';

export const findOpenConversationByCustomer = async (
  customerId: string
): Promise<conversation | null> => {
  return prisma.conversation.findFirst({
    where: {
      customer_id: customerId,
      status: 'open'
    },
    orderBy: {
      last_message_at: 'desc'
    }
  });
};

export const findLatestConversationByCustomer = async (
  customerId: string
): Promise<conversation | null> => {
  return prisma.conversation.findFirst({
    where: {
      customer_id: customerId
    },
    orderBy: {
      last_message_at: 'desc'
    }
  });
};

export const findLatestClosedConversationByCustomer = async (
  customerId: string,
  businessId: string
): Promise<conversation | null> => {
  return prisma.conversation.findFirst({
    where: {
      customer_id: customerId,
      business_id: businessId,
      status: 'closed'
    },
    orderBy: {
      last_message_at: 'desc'
    }
  });
};

export const createConversation = async (
  businessId: string,
  customerId: string
): Promise<conversation> => {
  return prisma.conversation.create({
    data: {
      business_id: businessId,
      customer_id: customerId,
      channel: 'whatsapp',
      status: 'open'
    }
  });
};

/**
 * Conversación mínima en `closed` cuando el negocio está cerrado y el cliente
 * no tenía conversación cerrada previa: solo para persistir el mensaje entrante
 * (no abre pedido ni crea `conversation_state`).
 */
export const createClosedConversationForOffHoursInbound = async (
  businessId: string,
  customerId: string
): Promise<conversation> => {
  return prisma.conversation.create({
    data: {
      business_id: businessId,
      customer_id: customerId,
      status: 'closed',
      last_message_at: new Date()
    }
  });
};

export const createOrGetOpenConversation = async (
  businessId: string,
  customerId: string
): Promise<conversation> => {
  // 1️⃣ Buscar conversación abierta para este negocio + cliente
  const existingOpen = await prisma.conversation.findFirst({
    where: {
      business_id: businessId,
      customer_id: customerId,
      status: 'open'
      },
      orderBy: {
        last_message_at: 'desc'
      }
  });

  if (existingOpen) {
    console.info('Conversación abierta encontrada', {
      conversationId: existingOpen.id,
      customerId
    });

    return existingOpen;
  }

  // 2️⃣ Si no hay abierta, buscar la última (cerrada) para reabrir
  const latest = await prisma.conversation.findFirst({
    where: {
      business_id: businessId,
      customer_id: customerId
    },
    orderBy: {
      last_message_at: 'desc'
    }
  });

  if (latest) {
    console.info('Reabriendo conversación existente', {
      conversationId: latest.id,
      customerId
    });

    return prisma.$transaction(async (tx) => {
      const sessionStart = new Date();
      const reopened = await tx.conversation.update({
        where: { id: latest.id },
        data: {
          status: 'open',
          started_at: sessionStart,
          last_message_at: sessionStart,
          lastReferencedProductId: null,
          idle_reminder_sent_at: null,
          idle_closed_at: null
        }
      });

      await tx.conversation_state.upsert({
        where: { conversation_id: latest.id },
        update: {
          current_intent: null,
          pending_action: null,
          mode: 'GLOBAL',
          metadata: {}
        },
        create: { conversation_id: latest.id }
      });

      return reopened;
    });
  }

  // 3️⃣ Si nunca hubo conversación → crear nueva
  console.info('Creando nueva conversación', {
    businessId,
    customerId
  });

  return prisma.$transaction(async (tx) => {
    const created = await tx.conversation.create({
      data: {
        business_id: businessId,
        customer_id: customerId,
        status: 'open',
        last_message_at: new Date()
      }
    });

    await tx.conversation_state.create({
      data: {
        conversation_id: created.id
      }
    });

    return created;
  });
};

export const updateConversationLastMessageAt = async (
  conversationId: string
): Promise<conversation> => {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { last_message_at: new Date() }
  });
};

/** Tras mensaje entrante: limpia flags de idle para reactivar recordatorios. */
export const clearConversationIdleTimestamps = async (
  conversationId: string
): Promise<conversation> => {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: {
      idle_reminder_sent_at: null,
      idle_closed_at: null
    }
  });
};

export const clearLastReferencedProductId = async (
  conversationId: string
): Promise<conversation> => {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { lastReferencedProductId: null }
  });
};

export const setLastReferencedProductId = async (
  conversationId: string,
  productId: string
): Promise<conversation> => {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { lastReferencedProductId: productId }
  });
};

/** Cierre tras confirmar reserva (idle / sin resetear conversation_state). */
export const closeConversationAfterReservation = async (
  conversationId: string
): Promise<conversation> => {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: {
      status: 'closed',
      idle_closed_at: new Date(),
      idle_reminder_sent_at: null,
      lastReferencedProductId: null
    }
  });
};

export const updateConversationSentiment = async (
  conversationId: string,
  sentiment: string,
): Promise<conversation> => {
  return prisma.conversation.update({
    where: { id: conversationId },
    data: {
      ai_sentiment: sentiment,
      ai_sentiment_updated_at: new Date(),
    },
  });
};

export const closeConversation = async (
  conversationId: string
): Promise<conversation> => {
  return prisma.$transaction(async (tx) => {
    const closed = await tx.conversation.update({
      where: { id: conversationId },
      data: {
        status: 'closed',
        last_message_at: new Date(),
        lastReferencedProductId: null
      }
    });
    await tx.conversation_state.upsert({
      where: { conversation_id: conversationId },
      update: {
        current_intent: null,
        pending_action: null,
        mode: 'GLOBAL',
        metadata: {}
      },
      create: { conversation_id: conversationId }
    });
    return closed;
  });
};
