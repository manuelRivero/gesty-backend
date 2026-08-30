/**
 * Máquina de estados y gate de completitud de promociones
 * (PLAN-ACCION-PROMOCIONES-PERSISTENCIA.md, D5/D6).
 *
 * D6: no se persisten promociones incompletas. Una oferta sin beneficio, o que
 * menciona productos sin vincular a `menu_item`, se rechaza con
 * `PROMOTION_INCOMPLETE` y la lista de lo que falta.
 */

import type {
  PromotionProductLink,
  PromotionStatus,
  StructuredOffer,
} from './promotionOffer.types';
import {
  collectConditionProblems,
  collectUnsupportedLimits,
  describeBenefitProblems,
  findAmbiguousGift,
} from './promotionConditions';

export const PROMOTION_STATUSES: PromotionStatus[] = [
  'draft',
  'active',
  'paused',
  'archived',
];

const ALLOWED_TRANSITIONS: Record<PromotionStatus, PromotionStatus[]> = {
  draft: ['active', 'archived'],
  active: ['draft', 'paused', 'archived'],
  paused: ['active', 'archived'],
  archived: [],
};

export const STATUS_LABELS: Record<PromotionStatus, string> = {
  draft: 'Borrador',
  active: 'Activa',
  paused: 'Pausada',
  archived: 'Archivada',
};

export class PromotionIncompleteError extends Error {
  readonly code = 'PROMOTION_INCOMPLETE';
  constructor(readonly missing: string[]) {
    super('La promoción está incompleta');
    this.name = 'PromotionIncompleteError';
  }
}

/**
 * La promoción está completa pero el motor no puede evaluarla de forma
 * determinista (D1/D2/B7). Se puede guardar como borrador; no se puede activar.
 */
export class PromotionNotEvaluableError extends Error {
  readonly code = 'PROMOTION_NOT_EVALUABLE';
  constructor(readonly missing: string[]) {
    super('La promoción no se puede evaluar automáticamente');
    this.name = 'PromotionNotEvaluableError';
  }
}

/** `free_product` del mismo platillo que la condición: 2x1 encubierto (D2). */
export class PromotionAmbiguousBenefitError extends Error {
  readonly code = 'PROMOTION_AMBIGUOUS_BENEFIT';
  constructor(readonly missing: string[]) {
    super('El beneficio de la promoción es ambiguo');
    this.name = 'PromotionAmbiguousBenefitError';
  }
}

export class PromotionInvalidTransitionError extends Error {
  readonly code = 'PROMOTION_INVALID_TRANSITION';
  constructor(
    readonly from: PromotionStatus,
    readonly to: PromotionStatus
  ) {
    super(`Transición inválida: ${from} → ${to}`);
    this.name = 'PromotionInvalidTransitionError';
  }
}

export function canTransition(from: PromotionStatus, to: PromotionStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: PromotionStatus, to: PromotionStatus): void {
  if (!canTransition(from, to)) {
    throw new PromotionInvalidTransitionError(from, to);
  }
}

/**
 * Nombres de producto mencionados en la oferta, con su `path`.
 * Es la misma convención de `path` que usan `unresolvedEntities` y los cards.
 */
export function collectProductPaths(
  offer: StructuredOffer
): Array<{ path: string; text: string; role: 'condition' | 'benefit' }> {
  const paths: Array<{ path: string; text: string; role: 'condition' | 'benefit' }> = [];

  offer.conditions.forEach((condition, index) => {
    const value = condition.value;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof (value as { productName?: unknown }).productName === 'string'
    ) {
      const text = (value as { productName: string }).productName.trim();
      if (text) {
        paths.push({
          path: `offer.conditions[${index}].value.productName`,
          text,
          role: 'condition',
        });
      }
    }
  });

  // `nth_free` (2x1 / 3x2) nombra el producto igual que `free_product`: mismo
  // path, mismo rol. El vínculo al menú es lo que después evalúa el motor.
  if (
    (offer.benefit?.type === 'free_product' || offer.benefit?.type === 'nth_free') &&
    offer.benefit.productName.trim()
  ) {
    paths.push({
      path: 'offer.benefit.productName',
      text: offer.benefit.productName.trim(),
      role: 'benefit',
    });
  }

  // Beneficio monetario apuntado a un platillo (`target.scope === 'product'`).
  if (offer.benefit && 'target' in offer.benefit && offer.benefit.target) {
    const target = offer.benefit.target;
    if (target.scope === 'product' && target.productName.trim()) {
      paths.push({
        path: 'offer.benefit.target.productName',
        text: target.productName.trim(),
        role: 'benefit',
      });
    }
  }

  return paths;
}

/**
 * Verifica que la promoción se pueda persistir: beneficio presente y todo
 * producto mencionado con su vínculo al menú. Lanza `PromotionIncompleteError`.
 */
export function assertPromotionComplete(params: {
  offer: StructuredOffer;
  productLinks: PromotionProductLink[];
}): void {
  const { offer, productLinks } = params;
  const missing: string[] = [];

  if (!offer.benefit) {
    missing.push('Falta definir el beneficio de la promoción');
  }

  const linkedPaths = new Set(productLinks.map((link) => link.path));
  for (const product of collectProductPaths(offer)) {
    if (!linkedPaths.has(product.path)) {
      missing.push(`Falta vincular "${product.text}" con un platillo del menú`);
    }
  }

  if (missing.length > 0) {
    throw new PromotionIncompleteError(missing);
  }
}

/**
 * Gate de ACTIVACIÓN (D1/D2/B7): completitud + evaluabilidad determinista.
 *
 * Guardar un borrador sigue exigiendo solo `assertPromotionComplete`. Pasar a
 * `active` exige además que el motor pueda evaluar la oferta sin adivinar:
 * campos y operadores de la whitelist, beneficio con destino explícito, sin
 * regalos ambiguos y sin límites de uso que no podemos hacer cumplir.
 *
 * ADR-0002: el Constraint vive en el borde del servicio, no en el prompt del
 * intérprete ni en la buena voluntad del panel.
 */
export function assertPromotionActivatable(params: {
  offer: StructuredOffer;
  productLinks: PromotionProductLink[];
}): void {
  const { offer, productLinks } = params;

  assertPromotionComplete(params);

  const notEvaluable = [
    ...collectConditionProblems(offer),
    ...(offer.benefit ? describeBenefitProblems(offer.benefit) : []),
    ...collectUnsupportedLimits(offer),
  ];
  if (notEvaluable.length > 0) {
    throw new PromotionNotEvaluableError(notEvaluable);
  }

  const menuItemIdByPath = new Map(
    productLinks.map((link) => [link.path, link.menuItemId])
  );
  const ambiguous = findAmbiguousGift({ offer, menuItemIdByPath });
  if (ambiguous) {
    throw new PromotionAmbiguousBenefitError([ambiguous]);
  }
}
