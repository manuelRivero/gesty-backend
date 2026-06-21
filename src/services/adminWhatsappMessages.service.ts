import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";

export type ListAdminWhatsappMessagesParams = {
  businessId: string;
  page: number;
  pageSize: number;
  conversationId?: string;
  customerPhone?: string;
};

export type ListAdminConversationsParams = {
  businessId: string;
  page: number;
  pageSize: number;
  sentiment?: string;
  customerPhone?: string;
};

export async function listAdminWhatsappMessages(
  params: ListAdminWhatsappMessagesParams
) {
  const { businessId, page, pageSize, conversationId, customerPhone } = params;
  const where: Prisma.conversation_messageWhereInput = {
    conversation: {
      business_id: businessId
    }
  };

  if (conversationId) {
    where.conversation_id = conversationId;
  }

  if (customerPhone?.trim()) {
    where.conversation = {
      business_id: businessId,
      customer: {
        phone_number: {
          contains: customerPhone.trim()
        }
      }
    };
  }

  const skip = (page - 1) * pageSize;
  const [total, rows] = await prisma.$transaction([
    prisma.conversation_message.count({ where }),
    prisma.conversation_message.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip,
      take: pageSize,
      include: {
        conversation: {
          select: {
            id: true,
            ai_sentiment: true,
            ai_sentiment_updated_at: true,
            conversation_state: {
              select: {
                is_human_handled: true
              }
            },
            customer: {
              select: {
                id: true,
                name: true,
                phone_number: true
              }
            }
          }
        }
      }
    })
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  const normalizedMessages = await Promise.all(
    rows.map((row, index) =>
      humanizeAdminMessage({
        message: row.message,
        isAiGenerated: row.is_ai_generated,
        businessId,
        previousMessage: rows[index - 1]?.message,
        nextMessage: rows[index + 1]?.message
      })
    )
  );

  return {
    items: rows.map((row, index) => ({
      ...row,
      message: normalizedMessages[index] ?? row.message,
      conversation: {
        id: row.conversation.id,
        customer: row.conversation.customer,
        botEnabled: !Boolean(row.conversation.conversation_state?.is_human_handled),
        aiSentiment: row.conversation.ai_sentiment ?? null,
        aiSentimentUpdatedAt: row.conversation.ai_sentiment_updated_at?.toISOString() ?? null,
      }
    })),
    total,
    page,
    pageSize,
    totalPages
  };
}

async function humanizeAdminMessage(params: {
  message: string;
  isAiGenerated: boolean;
  businessId: string;
  previousMessage?: string;
  nextMessage?: string;
}): Promise<string> {
  const { message, isAiGenerated, businessId, previousMessage, nextMessage } =
    params;
  const trimmed = message.trim();

  if (trimmed === "[interactive]") {
    const contextualPayload =
      extractLegacyInteractivePayloadId(previousMessage) ??
      extractLegacyInteractivePayloadId(nextMessage);
    if (contextualPayload) {
      const label = await humanizeInteractivePayloadId(contextualPayload, businessId);
      if (label.startsWith("Horario de reserva ")) {
        return "El bot envio opciones de horarios para reserva.";
      }
      return `El bot envio opciones de ${label.toLowerCase()}.`;
    }
    return isAiGenerated
      ? "El bot envio opciones interactivas."
      : "El cliente envio una respuesta interactiva.";
  }

  const payloadId = extractLegacyInteractivePayloadId(trimmed);
  if (payloadId) {
    const label = await humanizeInteractivePayloadId(payloadId, businessId);
    if (label.startsWith("Horario de reserva ")) {
      const time = label.replace("Horario de reserva ", "").trim();
      return `El cliente selecciono el horario de reserva: ${time}.`;
    }
    return `Selecciono opcion: ${label}`;
  }

  return message;
}

function extractLegacyInteractivePayloadId(value: string | undefined): string | null {
  if (!value) return null;
  const match = /^\[interactive:\s*(.+)\]$/i.exec(value.trim());
  return match?.[1]?.trim() ?? null;
}

async function humanizeInteractivePayloadId(
  payloadId: string,
  businessId: string
): Promise<string> {
  const reservationSlotMatch = /^RESERVATION_SLOT:([0-9a-fA-F-]{36})$/.exec(
    payloadId
  );
  if (reservationSlotMatch?.[1]) {
    const slot = await prisma.reservation_slot.findFirst({
      where: {
        id: reservationSlotMatch[1],
        business_id: businessId
      },
      select: {
        start_time: true
      }
    });
    if (slot?.start_time) {
      const hh = String(slot.start_time.getUTCHours()).padStart(2, "0");
      const mm = String(slot.start_time.getUTCMinutes()).padStart(2, "0");
      return `Horario de reserva ${hh}:${mm}`;
    }
    return "Seleccion de horario de reserva";
  }

  const staticLabels: Record<string, string> = {
    VIEW_MENU: "Ver menu",
    VIEW_MENU_RETURN: "Volver al menu",
    VIEW_CART: "Ver carrito",
    VIEW_ORDER: "Ver pedido",
    CHECKOUT: "Finalizar pedido",
    CANCEL_ORDER: "Cancelar pedido",
    END_CONVERSATION: "Terminar conversacion",
    ASK_QUESTION: "Hacer una pregunta",
    RESERVATION_CONFIRM: "Confirmar reserva",
    RESERVATION_CANCEL: "Cancelar reserva"
  };

  if (staticLabels[payloadId]) {
    return staticLabels[payloadId];
  }

  const prefixLabels: Array<{ prefix: string; label: string }> = [
    { prefix: "RESERVATION_SLOT:", label: "Seleccion de horario de reserva" },
    { prefix: "RESERVATION_ENV:", label: "Seleccion de ambiente de reserva" },
    { prefix: "CATEGORY_LIST_PAGE:", label: "Navegacion de pagina de categorias" },
    { prefix: "CATEGORY_PAGE:", label: "Navegacion de pagina de platillos" },
    { prefix: "CATEGORY:", label: "Seleccion de categoria" },
    { prefix: "SELECT_PRODUCT:", label: "Seleccion de producto" },
    { prefix: "SELECT_ORDER_PRODUCT:", label: "Seleccion de producto para pedido" },
    { prefix: "ORDER_SEARCH_PAGE:", label: "Navegacion de busqueda de productos" },
    { prefix: "ADD_ITEM:", label: "Agregar producto al pedido" },
    { prefix: "INCREASE_ITEM:", label: "Aumentar cantidad del producto" },
    { prefix: "DECREASE_ITEM:", label: "Disminuir cantidad del producto" },
    { prefix: "CONFIRM_INTENT:", label: "Confirmacion de intencion" },
    { prefix: "ONBOARDING_", label: "Flujo de onboarding de direccion" }
  ];

  const matched = prefixLabels.find((item) => payloadId.startsWith(item.prefix));
  if (matched) {
    return matched.label;
  }

  return "Opcion interactiva";
}

/**
 * Lista conversaciones del negocio con datos de sentiment para el inbox del admin.
 * Permite filtrar por sentiment y teléfono del cliente.
 */
export async function listAdminConversations(params: ListAdminConversationsParams) {
  const { businessId, page, pageSize, sentiment, customerPhone } = params;

  const where: Prisma.conversationWhereInput = { business_id: businessId };

  if (sentiment) {
    where.ai_sentiment = sentiment;
  }

  if (customerPhone?.trim()) {
    where.customer = {
      phone_number: { contains: customerPhone.trim() }
    };
  }

  const skip = (page - 1) * pageSize;
  const [total, rows] = await prisma.$transaction([
    prisma.conversation.count({ where }),
    prisma.conversation.findMany({
      where,
      orderBy: { last_message_at: "desc" },
      skip,
      take: pageSize,
      select: {
        id: true,
        status: true,
        started_at: true,
        last_message_at: true,
        ai_sentiment: true,
        ai_sentiment_updated_at: true,
        customer: {
          select: {
            id: true,
            name: true,
            phone_number: true,
          }
        },
        conversation_state: {
          select: {
            is_human_handled: true,
            current_intent: true,
          }
        },
      }
    })
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);

  return {
    items: rows.map((row) => ({
      id: row.id,
      status: row.status,
      startedAt: row.started_at.toISOString(),
      lastMessageAt: row.last_message_at.toISOString(),
      aiSentiment: row.ai_sentiment ?? null,
      aiSentimentUpdatedAt: row.ai_sentiment_updated_at?.toISOString() ?? null,
      customer: row.customer,
      botEnabled: !Boolean(row.conversation_state?.is_human_handled),
      currentIntent: row.conversation_state?.current_intent ?? null,
    })),
    total,
    page,
    pageSize,
    totalPages,
  };
}
