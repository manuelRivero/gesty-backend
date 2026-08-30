/**
 * Contratos del motor de evaluación de promociones (fase runtime).
 *
 * Separados de `promotionOffer.types.ts` a propósito: aquéllos describen lo que
 * el dueño AUTORIZÓ (la oferta persistida); éstos, lo que el carrito de un
 * cliente concreto PRODUCE en un instante. Nada de esto se persiste mientras el
 * pedido está en borrador (ADR-0003 / ADR-0005): se deriva en cada lectura.
 */

import type { Benefit, BenefitClass, StructuredOffer } from './promotionOffer.types';

/**
 * Línea de carrito para el evaluador. Es MÁS rica que `PricingItem`
 * (`pricing.service.ts`), que no tiene identidad de producto: el pricing suma
 * dinero, el evaluador necesita saber qué es cada cosa.
 */
export type EvaluatorCartLine = {
  productId: string;
  productName: string;
  quantity: number;
  /** Precio unitario efectivo, ya con el descuento de catálogo (D12). */
  unitPrice: number;
  variation: string | null;
};

/** Promoción activa y vigente, con sus vínculos al menú ya resueltos. */
export type EvaluatorPromotion = {
  id: string;
  name: string;
  offer: StructuredOffer;
  /** `menu_item_id` por `offer_path`, tal como lo confirmó el admin. */
  menuItemIdByPath: Record<string, string>;
  /** Fin de vigencia, para el desempate determinista (D4). */
  endsAt: string | null;
};

export type EvaluatorCustomerFacts = {
  isFirstPurchase: boolean;
};

/** Producto regalado: se materializa como línea a $0 al crear la orden (D3). */
export type GiftItem = {
  promotionId: string;
  productId: string;
  productName: string;
  quantity: number;
  /** Valor de catálogo, solo informativo: no entra en el cobro. */
  estimatedValue: number;
};

export type AppliedPromotion = {
  promotionId: string;
  name: string;
  benefitType: Benefit['type'];
  benefitClass: BenefitClass;
  /** Descuento monetario que este beneficio aporta al total (0 en gift/shipping). */
  monetaryDiscount: number;
  /** Ahorro comunicable al cliente, incluye regalo y envío. */
  savingValue: number;
  /** Copy corto ya calculado: el LLM no hace aritmética (ADR-0010). */
  summary: string;
  /**
   * Oferta tal como estaba al evaluar. Se congela en `order_promotion` porque
   * `updatePromotion` reemplaza el `offer` de la promoción viva: sin esto, la
   * historia financiera mutaría cuando el dueño edita la promo.
   */
  offerSnapshot: StructuredOffer;
};

/** Falta algo para desbloquear el beneficio. Insumo de la Opportunity. */
export type UnlockablePromotion = {
  promotionId: string;
  name: string;
  benefitType: Benefit['type'];
  benefitClass: BenefitClass;
  /** Qué falta, ya resuelto contra el menú real. */
  missing:
    | { kind: 'product'; productId: string; productName: string; units: number }
    | { kind: 'subtotal'; amount: number };
  /** Ahorro si el cliente completa la condición. Ordena el ranking (D4/D7). */
  estimatedSaving: number;
  /** Productos que la promo involucra: alimenta la supresión del cross-sell (D6). */
  relatedProductIds: string[];
  summary: string;
};

export type PromotionEvaluation = {
  applied: AppliedPromotion[];
  unlockable: UnlockablePromotion[];
  /** Único término que entra en el pricing (D3/D5). Nunca negativo. */
  monetaryDiscount: number;
  freeShipping: boolean;
  giftItems: GiftItem[];
  /** Base sobre la que se evaluó, para trazabilidad. */
  itemsTotal: number;
};

export const emptyPromotionEvaluation = (itemsTotal = 0): PromotionEvaluation => ({
  applied: [],
  unlockable: [],
  monetaryDiscount: 0,
  freeShipping: false,
  giftItems: [],
  itemsTotal,
});
