/**
 * Popularidad de productos para el bot (síntoma 3 de
 * PLAN-ACCION-CALIDAD-CONVERSACIONAL.md): "¿qué es lo más pedido?" respondido
 * con ventas reales, no con un flag manual de destacados.
 *
 * No reusa `getTopDishes` (`adminAnalytics.service.ts`) tal cual: esa función
 * está pensada para el panel de administración (rango de fechas obligatorio,
 * revenue) y acoplar el bot a ese contrato mezclaría dos consumidores con
 * necesidades distintas. Sí se reusa la consulta SQL de base.
 */

import { OrderStatus, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';

export interface PopularItem {
  id: string;
  name: string;
  orderCount: number;
  prices: Array<{ amount: string; currency: string }>;
}

export interface GetPopularMenuItemsInput {
  businessId: string;
  currencyCode?: string | null;
  /** Máximo de productos a devolver. Default 5. */
  limit?: number;
  /** Ventana temporal en días hacia atrás desde ahora. Default 30 (D8). */
  windowDays?: number;
}

export interface GetPopularMenuItemsResult {
  items: PopularItem[];
  /** false si no se llega al umbral mínimo — evita afirmar popularidad con datos escasos (D8). */
  significant: boolean;
}

const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_DAYS = 30;

/** Unidades mínimas vendidas en la ventana para considerar el ranking significativo. */
const MIN_TOTAL_UNITS_SOLD = 5;
/** Cantidad mínima de productos distintos con ventas para no depender de un solo hit aislado. */
const MIN_DISTINCT_PRODUCTS_SOLD = 3;

export async function getPopularMenuItems(
  input: GetPopularMenuItemsInput
): Promise<GetPopularMenuItemsResult> {
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 20));
  const windowDays = Math.max(1, input.windowDays ?? DEFAULT_WINDOW_DAYS);

  const rows = await prisma.$queryRaw<
    Array<{ menu_item_id: string; name: string; order_count: bigint }>
  >(
    Prisma.sql`
      SELECT
        oi.menu_item_id::text                    AS menu_item_id,
        mi.name,
        SUM(oi.quantity)::bigint                 AS order_count
      FROM order_item oi
      JOIN orders     o  ON o.id  = oi.order_id
      JOIN menu_item  mi ON mi.id = oi.menu_item_id
      WHERE o.business_id = ${input.businessId}::uuid
        AND o.created_at >= NOW() - (${windowDays} || ' days')::interval
        AND o.status <> ${OrderStatus.draft}::"OrderStatus"
        AND mi.is_available = true
      GROUP BY oi.menu_item_id, mi.name
      ORDER BY SUM(oi.quantity) DESC
    `
  );

  const totalUnitsSold = rows.reduce((sum, r) => sum + Number(r.order_count), 0);
  const significant =
    rows.length >= MIN_DISTINCT_PRODUCTS_SOLD && totalUnitsSold >= MIN_TOTAL_UNITS_SOLD;

  if (!significant) {
    return { items: [], significant: false };
  }

  // Hidratar precio activo hoy: un producto que vendió mucho pero que ya no
  // tiene precio configurado no es recomendable (D8 — "hoy sigue disponible").
  const now = new Date();
  const priceWhere: Prisma.menu_item_priceWhereInput = {
    is_active: true,
    valid_from: { lte: now },
    OR: [{ valid_to: null }, { valid_to: { gte: now } }],
    ...(input.currencyCode ? { currency_code: input.currencyCode } : {}),
  };

  const candidateIds = rows.map((r) => r.menu_item_id);
  const priced = await prisma.menu_item.findMany({
    where: {
      id: { in: candidateIds },
      is_available: true,
      menu_item_price: { some: priceWhere },
    },
    select: {
      id: true,
      menu_item_price: {
        where: priceWhere,
        select: { amount: true, currency_code: true },
      },
    },
  });
  const pricesById = new Map(
    priced.map((p) => [
      p.id,
      p.menu_item_price.map((price) => ({
        amount: price.amount.toString(),
        currency: price.currency_code,
      })),
    ])
  );

  const items: PopularItem[] = rows
    .filter((r) => pricesById.has(r.menu_item_id))
    .slice(0, limit)
    .map((r) => ({
      id: r.menu_item_id,
      name: r.name,
      orderCount: Number(r.order_count),
      prices: pricesById.get(r.menu_item_id) ?? [],
    }));

  return { items, significant: items.length > 0 };
}
