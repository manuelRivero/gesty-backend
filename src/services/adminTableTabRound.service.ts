import { FulfillmentType, OrderPaymentStatus, OrderStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { activePriceSelect, resolveEffectivePrice } from "../helpers/menuItemPrice.helper";
import { computeOrderPricing, type PricingItem } from "./pricing.service";

/**
 * Fase 3 de `docs/arquitectura/POS_TECHNICAL_DESIGN.md §4.B`: crea una ronda
 * de salón (`orders` + `order_item`) directo a partir de los ítems que manda
 * el mozo desde el panel, sin pasar por `draft_order`/`cart.service.ts` — esa
 * decisión ya quedó aprobada explícitamente (ver resumen de la auditoría de
 * `FulfillmentType`): el motor de carrito conversacional está diseñado
 * alrededor de una conversación de WhatsApp con estado, que no existe acá, y
 * forzarlo habría multiplicado los mismos defaults binarios que esa auditoría
 * encontró.
 *
 * Reutiliza únicamente las piezas de cálculo puro del checkout existente:
 * `computeOrderPricing` (`pricing.service.ts`) y el patrón de precio activo
 * ya usado por el menú (`menuItemPrice.helper.ts`). No reutiliza `draft_order`,
 * promociones (`resolveCartPromotions`) ni ajuste de método de pago — ninguno
 * de los tres está definido todavía para el ledger de pagos de salón (Fase 6),
 * y agregarlos ahora sería sobrearquitectura sin invariante que lo exija.
 *
 * Fase 4: genera las `kitchen_ticket`/`kitchen_ticket_item` correspondientes en
 * la MISMA transacción (`generateKitchenTickets`, abajo) — el ticket de cocina
 * nace atómico con la orden, nunca en un paso separado que pueda quedar
 * desincronizado.
 */

// ---------------------------------------------------------------------------
// Advisory lock — mismo patrón que `adminTableTab.service.ts`/`checkout.service.ts`.
// Keyed por `(business_id, table_tab_id)`: dos rondas concurrentes sobre la
// MISMA cuenta se serializan; dos rondas sobre cuentas distintas no se
// bloquean entre sí.
// ---------------------------------------------------------------------------

const tabLockKey = (businessId: string, tableTabId: string): string =>
  `table-tab:tab:${businessId}:${tableTabId}`;

const acquireTabLock = (
  tx: Prisma.TransactionClient,
  businessId: string,
  tableTabId: string
): Promise<unknown> =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tabLockKey(businessId, tableTabId)}))`;

/**
 * Cliente sentinela para rondas de salón: `orders.customer_id` es una FK
 * obligatoria (no nullable) heredada del núcleo comercial de e-commerce, que
 * siempre asume un cliente identificado (teléfono de WhatsApp). Una mesa no
 * tiene esa identidad. En vez de ensanchar `orders.customer_id` a nullable
 * (cambio estructural de alto impacto, fuera del alcance de esta Fase — esa
 * columna se usa en todo el núcleo comercial existente), se usa un único
 * `customer` sentinela por negocio, reutilizado por todas las rondas de
 * salón de ese negocio. No representa a ningún cliente real — solo satisface
 * el invariante de la FK. **PENDIENTE DE APROBACIÓN**: si el MVP necesita en
 * el futuro distinguir comensales reales (p. ej. para fidelización), este
 * sentinela deja de ser suficiente y requiere diseño propio — no resuelto
 * aquí.
 */
const DINE_IN_SENTINEL_PHONE = "__dine_in__";
const DINE_IN_SENTINEL_NAME = "Consumo en salón";

async function getOrCreateDineInSentinelCustomer(
  tx: Prisma.TransactionClient,
  businessId: string,
  preferredCurrency: string | null
) {
  return tx.customer.upsert({
    where: {
      business_id_phone_number: {
        business_id: businessId,
        phone_number: DINE_IN_SENTINEL_PHONE
      }
    },
    update: {},
    create: {
      business_id: businessId,
      phone_number: DINE_IN_SENTINEL_PHONE,
      name: DINE_IN_SENTINEL_NAME,
      preferred_currency: preferredCurrency ?? undefined
    }
  });
}

export type CreateTableTabRoundItemInput = {
  menuItemId: string;
  quantity: number;
  notes?: string;
  variation?: string;
};

export type CreateTableTabRoundResult =
  | { ok: true; orderId: string; total: number }
  | {
      ok: false;
      reason:
        | "EMPTY_ROUND"
        | "TABLE_TAB_NOT_FOUND"
        | "TABLE_TAB_NOT_OPEN"
        | "MENU_ITEM_NOT_FOUND"
        | "MENU_ITEM_UNAVAILABLE"
        | "PRICE_NOT_AVAILABLE";
      /** Para `MENU_ITEM_NOT_FOUND`/`MENU_ITEM_UNAVAILABLE`/`PRICE_NOT_AVAILABLE`: qué `menuItemId` falló. */
      menuItemId?: string;
    };

/**
 * Crea una ronda (una `orders` + sus `order_item`) sobre una `table_tab`
 * abierta, con los ítems que el mozo selecciona en el panel. Transaccional:
 * todo o nada, bajo el advisory lock de la cuenta.
 */
export async function createTableTabRound(params: {
  businessId: string;
  tableTabId: string;
  items: CreateTableTabRoundItemInput[];
}): Promise<CreateTableTabRoundResult> {
  const { businessId, tableTabId, items } = params;

  if (items.length === 0) {
    return { ok: false, reason: "EMPTY_ROUND" };
  }

  return prisma.$transaction(async (tx) => {
    await acquireTabLock(tx, businessId, tableTabId);

    const tab = await tx.table_tab.findFirst({
      where: { id: tableTabId, business_id: businessId }
    });
    if (!tab) {
      return { ok: false, reason: "TABLE_TAB_NOT_FOUND" } as const;
    }
    if (tab.status !== "open") {
      return { ok: false, reason: "TABLE_TAB_NOT_OPEN" } as const;
    }

    const business = await tx.business.findUniqueOrThrow({
      where: { id: businessId },
      select: { currency_code: true }
    });
    const currency = business.currency_code ?? null;

    const menuItemIds = [...new Set(items.map((i) => i.menuItemId))];
    const menuItems = await tx.menu_item.findMany({
      where: { id: { in: menuItemIds }, business_id: businessId },
      include: { menu_item_price: activePriceSelect(currency) }
    });
    const menuItemById = new Map(menuItems.map((m) => [m.id, m]));

    for (const menuItemId of menuItemIds) {
      const menuItem = menuItemById.get(menuItemId);
      if (!menuItem) {
        return { ok: false, reason: "MENU_ITEM_NOT_FOUND", menuItemId } as const;
      }
      if (!menuItem.is_available) {
        return { ok: false, reason: "MENU_ITEM_UNAVAILABLE", menuItemId } as const;
      }
      if (menuItem.menu_item_price.length === 0) {
        return { ok: false, reason: "PRICE_NOT_AVAILABLE", menuItemId } as const;
      }
    }

    const resolvedLines = items.map((item) => {
      const menuItem = menuItemById.get(item.menuItemId)!;
      const resolved = resolveEffectivePrice(menuItem);
      return { item, resolved };
    });

    const pricingItems: PricingItem[] = resolvedLines.map(({ item, resolved }) => ({
      quantity: item.quantity,
      unit_price: resolved.finalPrice,
      list_price: resolved.listPrice,
      discount_amount: resolved.discountAmount
    }));

    // Sin promociones ni ajuste de medio de pago (ver nota de cabecera) —
    // el total de una ronda de salón, por ahora, es la suma lisa de líneas.
    const pricing = computeOrderPricing(pricingItems);

    const dineInCustomer = await getOrCreateDineInSentinelCustomer(
      tx,
      businessId,
      currency
    );

    const order = await tx.orders.create({
      data: {
        business_id: businessId,
        customer_id: dineInCustomer.id,
        table_tab_id: tableTabId,
        status: OrderStatus.placed,
        payment_status: OrderPaymentStatus.unpaid,
        fulfillment_type: FulfillmentType.DINE_IN,
        currency_code: currency ?? "ARS",
        total_amount: pricing.total,
        order_item: {
          create: resolvedLines.map(({ item, resolved }) => ({
            menu_item_id: item.menuItemId,
            quantity: item.quantity,
            unit_price: resolved.finalPrice,
            list_price: resolved.listPrice,
            discount_amount: resolved.discountAmount.gt(0) ? resolved.discountAmount : undefined,
            notes: item.notes ?? undefined,
            variation: item.variation ?? undefined
          }))
        }
      },
      include: { order_item: true }
    });

    await generateKitchenTickets(tx, order.id, order.order_item);

    return { ok: true, orderId: order.id, total: pricing.total } as const;
  });
}

/**
 * Genera, dentro de la misma transacción de la ronda (Fase 4,
 * POS_TECHNICAL_DESIGN.md §4.B), una `kitchen_ticket` por cada estación
 * involucrada en la orden recién creada, con sus `kitchen_ticket_item`
 * correspondientes. Idempotente vía `upsert` sobre el índice único
 * `(order_id, station_id)`: si esta función se llamara dos veces para la misma
 * orden, la segunda vez reutiliza el ticket existente de cada estación en vez
 * de duplicarlo.
 *
 * Un `menu_item` sin estación asignada (`menu_item_station`) no genera comanda
 * — se asume deliberadamente operativo (p. ej. un ítem que no requiere
 * preparación), no un error; no bloquea la creación de la ronda.
 */
async function generateKitchenTickets(
  tx: Prisma.TransactionClient,
  orderId: string,
  orderItems: Array<{ id: string; menu_item_id: string }>
): Promise<void> {
  const menuItemIds = [...new Set(orderItems.map((i) => i.menu_item_id))];
  const stationLinks = await tx.menu_item_station.findMany({
    where: { menu_item_id: { in: menuItemIds } }
  });
  const stationIdByMenuItemId = new Map(stationLinks.map((l) => [l.menu_item_id, l.station_id]));

  const orderItemIdsByStationId = new Map<string, string[]>();
  for (const orderItem of orderItems) {
    const stationId = stationIdByMenuItemId.get(orderItem.menu_item_id);
    if (!stationId) continue;
    const bucket = orderItemIdsByStationId.get(stationId);
    if (bucket) {
      bucket.push(orderItem.id);
    } else {
      orderItemIdsByStationId.set(stationId, [orderItem.id]);
    }
  }

  for (const [stationId, orderItemIds] of orderItemIdsByStationId) {
    const ticket = await tx.kitchen_ticket.upsert({
      where: { order_id_station_id: { order_id: orderId, station_id: stationId } },
      update: {},
      create: { order_id: orderId, station_id: stationId }
    });

    await tx.kitchen_ticket_item.createMany({
      data: orderItemIds.map((orderItemId) => ({
        kitchen_ticket_id: ticket.id,
        order_item_id: orderItemId
      }))
    });
  }
}
