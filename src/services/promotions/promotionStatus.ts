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

  if (offer.benefit?.type === 'free_product' && offer.benefit.productName.trim()) {
    paths.push({
      path: 'offer.benefit.productName',
      text: offer.benefit.productName.trim(),
      role: 'benefit',
    });
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
