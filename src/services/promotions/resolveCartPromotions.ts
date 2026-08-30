/**
 * Adaptador con I/O entre el carrito real y el evaluador puro.
 *
 * Único punto de entrada del motor para el resto del sistema: pricing,
 * checkout, pago y (en el bloque conversacional) el contexto del agente.
 * Nada de lo que devuelve se persiste mientras el pedido es borrador
 * (ADR-0003 / ADR-0005): se deriva en cada lectura.
 *
 * **Nunca lanza.** Un fallo del motor degrada a "sin promociones": preferimos
 * cobrar el precio de lista a romper el turno o el checkout.
 */

import { prisma } from '../../lib/prisma';
import { findActivePromotions, findCatalogPrices } from './activePromotions.repository';
import { evaluatePromotions } from './evaluatePromotions';
import {
  emptyPromotionEvaluation,
  type EvaluatorCartLine,
  type PromotionEvaluation,
} from './promotionEvaluation.types';

const DEFAULT_TIMEZONE = 'America/Argentina/Buenos_Aires';

export type ResolveCartPromotionsParams = {
  businessId: string;
  draftOrderId: string;
  /** Para `order.isFirstPurchase`. Sin cliente se asume que no es la primera. */
  customerId?: string | null;
  /** Envío vigente, solo para valuar `free_shipping` en el copy. */
  deliveryFee?: number;
  /** Instante de evaluación. En la creación de la orden es el `now` real (D13). */
  now?: Date;
};

export const resolveCartPromotions = async (
  params: ResolveCartPromotionsParams
): Promise<PromotionEvaluation> => {
  const now = params.now ?? new Date();

  try {
    const [lines, business, promotions] = await Promise.all([
      prisma.draft_order_item.findMany({
        where: { draft_order_id: params.draftOrderId },
        include: { menu_item: { select: { id: true, name: true } } },
        orderBy: { id: 'asc' },
      }),
      prisma.business.findUnique({
        where: { id: params.businessId },
        select: { timezone: true },
      }),
      findActivePromotions({ businessId: params.businessId, now }),
    ]);

    if (lines.length === 0 || promotions.length === 0) {
      return emptyPromotionEvaluation();
    }

    const cartLines: EvaluatorCartLine[] = lines
      .filter((line) => line.product_id)
      .map((line) => ({
        productId: line.product_id!,
        productName: line.menu_item?.name ?? 'Producto',
        quantity: line.quantity,
        // Precio EFECTIVO ya congelado en la línea (post descuento de catálogo).
        unitPrice: line.unit_price.toNumber(),
        variation: line.variation ?? null,
      }));

    // Productos que la promo nombra pero que pueden no estar en el carrito
    // (regalo, unidad faltante): necesitan precio de catálogo para valuarse.
    const referencedProductIds = promotions.flatMap((promotion) =>
      Object.values(promotion.menuItemIdByPath)
    );
    const catalogPriceByProductId = await findCatalogPrices({
      businessId: params.businessId,
      productIds: referencedProductIds,
    });

    const isFirstPurchase = params.customerId
      ? (await prisma.orders.count({
          where: { business_id: params.businessId, customer_id: params.customerId },
        })) === 0
      : false;

    const evaluation = evaluatePromotions(
      {
        cartLines,
        promotions,
        customerFacts: { isFirstPurchase },
        now,
        timezone: business?.timezone ?? DEFAULT_TIMEZONE,
      },
      {
        deliveryFee: params.deliveryFee ?? 0,
        catalogPriceByProductId,
      }
    );

    if (evaluation.applied.length > 0 || evaluation.unlockable.length > 0) {
      console.log(
        JSON.stringify({
          event: '[promotion] evaluated',
          businessId: params.businessId,
          draftOrderId: params.draftOrderId,
          applied: evaluation.applied.map((item) => ({
            promotionId: item.promotionId,
            benefitType: item.benefitType,
            monetaryDiscount: item.monetaryDiscount,
          })),
          unlockable: evaluation.unlockable.map((item) => item.promotionId),
          monetaryDiscount: evaluation.monetaryDiscount,
          freeShipping: evaluation.freeShipping,
          itemsTotal: evaluation.itemsTotal,
        })
      );
    }

    return evaluation;
  } catch (err) {
    console.error('[promotion] resolveCartPromotions failed', err);
    return emptyPromotionEvaluation();
  }
};

/**
 * Firma de la evaluación para comparar dos instantes (D13): si cambia entre el
 * resumen que el cliente confirmó y la creación de la orden, hay que
 * re-confirmar en vez de cobrar un total que nadie aprobó.
 */
export const promotionSignature = (evaluation: PromotionEvaluation): string =>
  JSON.stringify({
    monetaryDiscount: evaluation.monetaryDiscount,
    freeShipping: evaluation.freeShipping,
    gifts: evaluation.giftItems
      .map((gift) => `${gift.productId}x${gift.quantity}`)
      .sort(),
    promotions: evaluation.applied.map((item) => item.promotionId).sort(),
  });
