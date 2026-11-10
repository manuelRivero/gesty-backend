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
  menuItemName: string;
  quantity: number;
  notes: string | null;
  variation: string | null;
};

export type KitchenTicketSnapshot = {
  id: string;
  orderId: string;
  stationId: string;
  createdAt: Date;
  /** Mesas activas de la cuenta de salón que originó el pedido (vacío si no es DINE_IN). */
  tableNames: string[];
  /**
   * Posición de esta ronda entre todas las de la misma cuenta de salón
   * (1 = primera ronda abierta), mismo criterio que usa `/pos` ("Ronda N").
   * `null` si el pedido no viene de una cuenta de salón.
   */
  roundNumber: number | null;
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
      order: {
        select: {
          table_tab_id: true,
          table_tab: {
            select: {
              tables: {
                where: { unassigned_at: null },
                select: { table: { select: { name: true } } }
              }
            }
          }
        }
      },
      kitchen_ticket_item: {
        where: status ? { status } : undefined,
        orderBy: { created_at: "asc" },
        include: {
          order_item: {
            select: {
              id: true,
              menu_item_id: true,
              quantity: true,
              notes: true,
              variation: true,
              menu_item: { select: { name: true } }
            }
          }
        }
      }
    }
  });

  const tableTabIds = [...new Set(tickets.map((t) => t.order.table_tab_id).filter((id): id is string => id != null))];
  const roundNumberByOrderId = new Map<string, number>();
  if (tableTabIds.length > 0) {
    const rounds = await prisma.orders.findMany({
      where: { table_tab_id: { in: tableTabIds } },
      orderBy: { created_at: "asc" },
      select: { id: true, table_tab_id: true }
    });
    const seenPerTableTab = new Map<string, number>();
    for (const round of rounds) {
      const tabId = round.table_tab_id as string;
      const nextNumber = (seenPerTableTab.get(tabId) ?? 0) + 1;
      seenPerTableTab.set(tabId, nextNumber);
      roundNumberByOrderId.set(round.id, nextNumber);
    }
  }

  return tickets.map((ticket) => ({
    id: ticket.id,
    orderId: ticket.order_id,
    stationId: ticket.station_id,
    createdAt: ticket.created_at,
    tableNames: ticket.order.table_tab?.tables.map((t) => t.table.name) ?? [],
    roundNumber: roundNumberByOrderId.get(ticket.order_id) ?? null,
    items: ticket.kitchen_ticket_item.map((item) => ({
      id: item.id,
      orderItemId: item.order_item_id,
      status: item.status,
      menuItemId: item.order_item.menu_item_id,
      menuItemName: item.order_item.menu_item.name,
      quantity: item.order_item.quantity,
      notes: item.order_item.notes,
      variation: item.order_item.variation
    }))
  }));
}
