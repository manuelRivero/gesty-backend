/**
 * Capa de presentación para el panel admin.
 * El JSON estructurado queda en `offer`; `display` es lo que el front muestra.
 */

import type {
  Benefit,
  Condition,
  ConditionOperator,
  OfferValidity,
  PromotionEntityCandidate,
  PromotionEntityCard,
  PromotionDisplayCondition,
  PromotionInterpretationDisplay,
  StructuredOffer,
  UnresolvedEntity,
} from './promotionOffer.types';

export type {
  PromotionEntityCard,
  PromotionDisplayCondition,
  PromotionInterpretationDisplay,
};

const DAY_NAMES = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
] as const;

const OPERATOR_LABELS: Record<ConditionOperator, string> = {
  eq: 'igual a',
  neq: 'distinto de',
  gt: 'mayor a',
  gte: 'al menos',
  lt: 'menor a',
  lte: 'como máximo',
  in: 'en',
  contains: 'incluye',
};

function formatMoneyHint(value: number): string {
  try {
    return new Intl.NumberFormat('es-AR', {
      style: 'decimal',
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return String(value);
  }
}

function productValueLabel(value: unknown): {
  productName?: string;
  quantity?: number;
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { productName?: unknown; quantity?: unknown };
  if (typeof v.productName !== 'string' || !v.productName.trim()) return null;
  return {
    productName: v.productName.trim(),
    quantity: typeof v.quantity === 'number' ? v.quantity : undefined,
  };
}

export function formatConditionLabel(condition: Condition): string {
  const op = OPERATOR_LABELS[condition.operator] ?? condition.operator;
  const product = productValueLabel(condition.value);

  if (condition.field === 'cart.product' && product) {
    const qty = product.quantity;
    if (qty != null) {
      if (condition.operator === 'gte') {
        return qty === 1
          ? `Si compra ${product.productName}`
          : `Si compra al menos ${qty} × ${product.productName}`;
      }
      if (condition.operator === 'eq') {
        return `Si compra exactamente ${qty} × ${product.productName}`;
      }
      if (condition.operator === 'gt') {
        return `Si compra más de ${qty} × ${product.productName}`;
      }
      return `Si lleva ${op} ${qty} × ${product.productName}`;
    }
    return `Si el pedido incluye ${product.productName}`;
  }

  if (condition.field === 'cart.subtotal' && typeof condition.value === 'number') {
    const amount = formatMoneyHint(condition.value);
    if (condition.operator === 'gt') return `En pedidos de más de $${amount}`;
    if (condition.operator === 'gte') return `En pedidos de $${amount} o más`;
    if (condition.operator === 'lt') return `En pedidos de menos de $${amount}`;
    if (condition.operator === 'lte') return `En pedidos de hasta $${amount}`;
    return `Cuando el total es ${op} $${amount}`;
  }

  if (condition.field === 'cart.itemCount' && typeof condition.value === 'number') {
    return `Cuando el carrito tiene ${op} ${condition.value} ítems`;
  }

  if (condition.field === 'order.isFirstPurchase') {
    return condition.value === true
      ? 'Solo en la primera compra'
      : 'No aplica a la primera compra';
  }

  // Fallback legible sin JSON crudo
  if (product) {
    return `Condición sobre ${product.productName}`;
  }
  if (typeof condition.value === 'number' || typeof condition.value === 'string') {
    return `${humanField(condition.field)} ${op} ${condition.value}`;
  }
  return `${humanField(condition.field)} (${op})`;
}

function humanField(field: string): string {
  const map: Record<string, string> = {
    'cart.product': 'Producto del carrito',
    'cart.subtotal': 'Total del pedido',
    'cart.itemCount': 'Cantidad de ítems',
    'order.isFirstPurchase': 'Primera compra',
    'order.shipping': 'Envío',
  };
  return map[field] ?? field.replace(/\./g, ' › ');
}

export function formatBenefitLabel(benefit: Benefit | null | undefined): string | null {
  if (!benefit) return null;
  switch (benefit.type) {
    case 'percentage_discount':
      return `${benefit.value}% de descuento`;
    case 'fixed_discount':
      return `$${formatMoneyHint(benefit.value)} de descuento`;
    case 'fixed_price':
      return `Precio fijo $${formatMoneyHint(benefit.value)}`;
    case 'free_product':
      return benefit.quantity === 1
        ? `Regalo: ${benefit.productName}`
        : `Regalo: ${benefit.quantity} × ${benefit.productName}`;
    case 'free_shipping':
      return 'Envío gratis';
    default:
      return null;
  }
}

export function formatValidityLines(validity: OfferValidity | undefined): string[] {
  if (!validity) return [];
  const lines: string[] = [];

  if (validity.daysOfWeek?.length) {
    const days = validity.daysOfWeek
      .map((d) => DAY_NAMES[d] ?? `Día ${d}`)
      .join(', ');
    lines.push(`Días: ${days}`);
  }

  if (validity.timeRange) {
    lines.push(`Horario: ${validity.timeRange.from} a ${validity.timeRange.to}`);
  }

  if (validity.startsAt || validity.endsAt) {
    if (validity.startsAt && validity.endsAt) {
      lines.push(`Vigencia: ${validity.startsAt} → ${validity.endsAt}`);
    } else if (validity.startsAt) {
      lines.push(`Desde: ${validity.startsAt}`);
    } else if (validity.endsAt) {
      lines.push(`Hasta: ${validity.endsAt}`);
    }
  }

  return lines;
}

function titleCaseName(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function iconForKind(kind: UnresolvedEntity['type']): PromotionEntityCard['icon'] {
  if (kind === 'product') return 'utensils';
  if (kind === 'category') return 'tag';
  return 'circle-help';
}

/** Resolución de una entidad contra el catálogo, por `path` del offer. */
export type EntityResolution = {
  path: string;
  candidates: PromotionEntityCandidate[];
  resolved: boolean;
};

function subtitleFor(
  entity: UnresolvedEntity,
  resolution: EntityResolution | undefined
): string {
  if (entity.type !== 'product') {
    return entity.type === 'category'
      ? 'Pendiente de vincular a una categoría'
      : 'Pendiente de revisar';
  }
  if (resolution?.resolved) return 'Vinculado al menú';
  if (resolution && resolution.candidates.length > 0) {
    return 'Elegí el platillo del menú';
  }
  if (resolution) return 'No encontramos este platillo en el menú';
  return 'Pendiente de vincular al menú';
}

export function buildEntityCards(
  entities: UnresolvedEntity[],
  resolutions: EntityResolution[] = []
): PromotionEntityCard[] {
  const byPath = new Map(resolutions.map((item) => [item.path, item]));
  const seen = new Set<string>();
  const cards: PromotionEntityCard[] = [];

  for (const entity of entities) {
    const key = `${entity.type}|${entity.text.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const resolution = byPath.get(entity.path);
    const preselected = resolution?.resolved ? resolution.candidates[0] : undefined;

    cards.push({
      name: titleCaseName(entity.text),
      kind: entity.type,
      icon: iconForKind(entity.type),
      productId: preselected?.menuItemId ?? null,
      thumbnailUrl: preselected?.thumbnailUrl ?? null,
      resolved: Boolean(preselected),
      path: entity.path,
      subtitle: subtitleFor(entity, resolution),
      candidates: resolution?.candidates ?? [],
    });
  }

  return cards;
}

export function buildPromotionDisplay(params: {
  status: 'complete' | 'needs_clarification';
  offer: StructuredOffer;
  unresolvedEntities: UnresolvedEntity[];
  resolutions?: EntityResolution[];
}): PromotionInterpretationDisplay {
  const { status, offer, unresolvedEntities, resolutions } = params;

  return {
    statusLabel:
      status === 'complete' ? 'Borrador usable' : 'Falta información',
    benefitLabel: formatBenefitLabel(offer.benefit),
    conditions: offer.conditions.map((condition, index) => ({
      index,
      label: formatConditionLabel(condition),
    })),
    validityLines: formatValidityLines(offer.validity),
    stackingLabel:
      offer.stacking == null
        ? null
        : offer.stacking.allowed
          ? 'Se puede combinar con otras promos'
          : 'No se combina con otras promos',
    entityCards: buildEntityCards(unresolvedEntities, resolutions),
  };
}

/** Línea única para la fila del listado: beneficio + días + horario. */
export function buildSummaryLine(offer: StructuredOffer): string {
  const parts: string[] = [];
  const benefit = formatBenefitLabel(offer.benefit);
  if (benefit) parts.push(benefit);

  if (offer.validity?.daysOfWeek?.length) {
    parts.push(
      offer.validity.daysOfWeek.map((d) => DAY_NAMES[d] ?? `Día ${d}`).join(', ')
    );
  }
  if (offer.validity?.timeRange) {
    parts.push(`${offer.validity.timeRange.from} a ${offer.validity.timeRange.to}`);
  }

  return parts.join(' · ');
}
