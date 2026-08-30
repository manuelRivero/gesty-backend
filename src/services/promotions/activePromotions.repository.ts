/**
 * Lectura de promociones activas para el motor runtime. **Sin escrituras.**
 *
 * El filtro de vigencia fino (día / horario) vive en el evaluador, que es puro
 * y testeable: acá solo se acota lo que se puede acotar en SQL sin conocer la
 * timezone del negocio (`status='active'` y la ventana de fechas).
 */

import { prisma } from '../../lib/prisma';
import type { EvaluatorPromotion } from './promotionEvaluation.types';
import type { StructuredOffer } from './promotionOffer.types';
import { StructuredOfferSchema } from './promotionInterpreter.schemas';

const parseOffer = (raw: unknown): StructuredOffer | null => {
  const parsed = StructuredOfferSchema.safeParse(raw);
  return parsed.success ? (parsed.data as StructuredOffer) : null;
};

/**
 * Promociones `active` del negocio, con sus vínculos al menú resueltos.
 * Una fila cuyo `offer` no parsea se descarta con log: nunca rompe el turno.
 */
export const findActivePromotions = async (params: {
  businessId: string;
  now?: Date;
}): Promise<EvaluatorPromotion[]> => {
  const now = params.now ?? new Date();

  const rows = await prisma.promotion.findMany({
    where: {
      business_id: params.businessId,
      status: 'active',
      AND: [
        { OR: [{ starts_at: null }, { starts_at: { lte: now } }] },
        { OR: [{ ends_at: null }, { ends_at: { gte: now } }] },
      ],
    },
    include: { products: true },
    orderBy: { created_at: 'asc' },
  });

  const promotions: EvaluatorPromotion[] = [];

  for (const row of rows) {
    const offer = parseOffer(row.offer);
    if (!offer || !offer.benefit) {
      console.log(
        JSON.stringify({
          event: '[promotion] not_evaluable',
          reason: 'offer_parse_failed',
          businessId: params.businessId,
          promotionId: row.id,
        })
      );
      continue;
    }

    const menuItemIdByPath: Record<string, string> = {};
    for (const link of row.products) {
      menuItemIdByPath[link.offer_path] = link.menu_item_id;
    }

    promotions.push({
      id: row.id,
      name: row.name,
      offer,
      menuItemIdByPath,
      endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    });
  }

  return promotions;
};

/**
 * Precio de catálogo vigente de un conjunto de productos. Se usa para valuar
 * regalos y desbloqueables (productos que todavía NO están en el carrito y por
 * lo tanto no tienen precio congelado en una línea).
 */
export const findCatalogPrices = async (params: {
  businessId: string;
  productIds: string[];
}): Promise<Record<string, number>> => {
  const ids = [...new Set(params.productIds)].filter(Boolean);
  if (ids.length === 0) return {};

  const items = await prisma.menu_item.findMany({
    where: { id: { in: ids }, business_id: params.businessId, is_available: true },
    select: {
      id: true,
      discount_type: true,
      discount_value: true,
      menu_item_price: {
        where: {
          is_active: true,
          valid_from: { lte: new Date() },
          OR: [{ valid_to: null }, { valid_to: { gte: new Date() } }],
        },
        orderBy: { valid_from: 'desc' },
        take: 1,
      },
    },
  });

  const { resolveEffectivePrice } = await import('../../helpers/menuItemPrice.helper');

  const prices: Record<string, number> = {};
  for (const item of items) {
    // D12: precio EFECTIVO (post descuento de catálogo). Valuar a precio de
    // lista descontaría más de lo que se cobra.
    prices[item.id] = resolveEffectivePrice(item).finalPrice.toNumber();
  }
  return prices;
};
