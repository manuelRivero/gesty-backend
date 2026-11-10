import { KitchenTicketItemStatus } from "@prisma/client";
import { prisma } from "../lib/prisma";

/**
 * Fase 5 de `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.C`: snapshot REST de
 * comandas abiertas. El KDS lo usa al montar, al reconectar, y como polling
 * de seguridad periódico — nunca debe depender exclusivamente de los eventos
 * Socket.IO (`admin:kitchen`) para reconstruir su estado (ver nota de
 * recuperación ante reconexión en §4.C / `adminSocket.ts`). Esta consulta es
 * la fuente de verdad; el socket es solo el aviso de baja latencia.
 */

export type KitchenTicketSnapshotItem = {
  id: string;
  orderItemId: string;
  status: KitchenTicketItemStatus;
  menuItemId: string;
  quantity: number;
  notes: string | null;
  variation: string | null;
};

export type KitchenTicketSnapshot = {
  id: string;
  orderId: string;
  stationId: string;
  createdAt: Date;
  items: KitchenTicketSnapshotItem[];
};

export async function listKitchenTickets(params: {
  businessId: string;
  stationId?: string;
  status?: KitchenTicketItemStatus;
}): Promise<KitchenTicketSnapshot[]> {
  const { businessId, stationId, status } = params;

  const tickets = await prisma.kitchen_ticket.findMany({
    where: {
      order: { business_id: businessId },
      ...(stationId ? { station_id: stationId } : {}),
      ...(status ? { kitchen_ticket_item: { some: { status } } } : {})
    },
    orderBy: { created_at: "asc" },
    include: {
      kitchen_ticket_item: {
        where: status ? { status } : undefined,
        orderBy: { created_at: "asc" },
        include: {
          order_item: {
            select: { id: true, menu_item_id: true, quantity: true, notes: true, variation: true }
          }
        }
      }
    }
  });

  return tickets.map((ticket) => ({
    id: ticket.id,
    orderId: ticket.order_id,
    stationId: ticket.station_id,
    createdAt: ticket.created_at,
    items: ticket.kitchen_ticket_item.map((item) => ({
      id: item.id,
      orderItemId: item.order_item_id,
      status: item.status,
      menuItemId: item.order_item.menu_item_id,
      quantity: item.order_item.quantity,
      notes: item.order_item.notes,
      variation: item.order_item.variation
    }))
  }));
}
