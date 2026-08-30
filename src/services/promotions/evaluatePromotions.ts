/**
 * Motor de evaluación de promociones. **Función pura**: sin base, sin LLM, sin
 * escrituras (ADR-0004: un derivador no produce efectos).
 *
 * Invariantes que sostienen todo el diseño:
 * 1. **Idempotencia por construcción.** No escribe nada, así que llamarlo N
 *    veces con el mismo carrito da el mismo resultado. El "doble descuento" no
 *    se resuelve: no existe.
 * 2. **La base de evaluación no incluye promociones.** `cart.subtotal` es el
 *    total de ítems post-catálogo y pre-promoción (D1). Si incluyera el
 *    descuento, una promo que baja el subtotal bajo su propio umbral se
 *    desactivaría a sí misma y esto dejaría de ser una función.
 * 3. **Selección determinista.** Clases disjuntas (D4) y desempate estable:
 *    ahorro DESC → `ends_at` ASC → `id` ASC. Mismo carrito, misma ganadora.
 * 4. **El LLM no participa.** Elegibilidad, montos y prioridad son código.
 */

import {
  benefitClassOf,
  type Benefit,
  type BenefitClass,
  type EvaluableCondition,
} from './promotionOffer.types';
import { toEvaluableCondition } from './promotionConditions';
import {
  emptyPromotionEvaluation,
  type AppliedPromotion,
  type EvaluatorCartLine,
  type EvaluatorCustomerFacts,
  type EvaluatorPromotion,
  type GiftItem,
  type PromotionEvaluation,
  type UnlockablePromotion,
} from './promotionEvaluation.types';

export type EvaluatePromotionsInput = {
  cartLines: EvaluatorCartLine[];
  promotions: EvaluatorPromotion[];
  customerFacts: EvaluatorCustomerFacts;
  now: Date;
  /** Timezone del negocio: "los martes de 18 a 20" es hora local, no UTC. */
  timezone: string;
};

const round2 = (value: number): number => Math.round(value * 100) / 100;

// ---------------------------------------------------------------------------
// Vigencia (misma técnica que `businessHours.service.ts`: Intl, no dayjs)
// ---------------------------------------------------------------------------

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const localParts = (timezone: string, date: Date): { weekday: number; minutes: number } => {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const weekday = parts.find((p) => p.type === 'weekday')?.value.toLowerCase() ?? 'sunday';
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return { weekday: WEEKDAY_INDEX[weekday] ?? 0, minutes: hour * 60 + minute };
  } catch {
    // Timezone inválida: se degrada a la del servidor antes que romper el turno.
    return { weekday: date.getDay(), minutes: date.getHours() * 60 + date.getMinutes() };
  }
};

const toMinutes = (hhmm: string): number => {
  const [hh, mm] = hhmm.split(':').map((part) => Number(part));
  return (hh || 0) * 60 + (mm || 0);
};

export const isPromotionInValidityWindow = (
  promotion: EvaluatorPromotion,
  now: Date,
  timezone: string
): boolean => {
  const validity = promotion.offer.validity;
  if (!validity) return true;

  if (validity.startsAt) {
    const startsAt = new Date(validity.startsAt);
    if (!Number.isNaN(startsAt.getTime()) && now < startsAt) return false;
  }
  if (validity.endsAt) {
    const endsAt = new Date(validity.endsAt);
    if (!Number.isNaN(endsAt.getTime()) && now > endsAt) return false;
  }

  const { weekday, minutes } = localParts(timezone, now);

  if (validity.daysOfWeek?.length && !validity.daysOfWeek.includes(weekday)) {
    return false;
  }

  if (validity.timeRange) {
    const from = toMinutes(validity.timeRange.from);
    const to = toMinutes(validity.timeRange.to);
    const inRange =
      to > from ? minutes >= from && minutes < to : minutes >= from || minutes < to;
    if (!inRange) return false;
  }

  return true;
};

// ---------------------------------------------------------------------------
// Condiciones
// ---------------------------------------------------------------------------

const itemsTotalOf = (lines: EvaluatorCartLine[]): number =>
  round2(lines.reduce((acc, line) => acc + line.quantity * line.unitPrice, 0));

/** B1: `cart.itemCount` cuenta unidades, no líneas. */
const unitCountOf = (lines: EvaluatorCartLine[]): number =>
  lines.reduce((acc, line) => acc + line.quantity, 0);

/**
 * D13/B6: las variaciones del mismo platillo son líneas separadas por diseño,
 * pero la promoción habla del producto — se suman.
 */
const unitsOfProduct = (lines: EvaluatorCartLine[], productId: string): number =>
  lines
    .filter((line) => line.productId === productId)
    .reduce((acc, line) => acc + line.quantity, 0);

const compare = (actual: number, operator: string, expected: number): boolean => {
  switch (operator) {
    case 'gte':
      return actual >= expected;
    case 'gt':
      return actual > expected;
    case 'lte':
      return actual <= expected;
    case 'lt':
      return actual < expected;
    case 'eq':
      return actual === expected;
    default:
      return false;
  }
};

type ConditionOutcome =
  | { met: true }
  | { met: false; missing: UnlockablePromotion['missing'] | null };

const evaluateCondition = (params: {
  condition: EvaluableCondition;
  conditionIndex: number;
  promotion: EvaluatorPromotion;
  lines: EvaluatorCartLine[];
  customerFacts: EvaluatorCustomerFacts;
}): ConditionOutcome => {
  const { condition, conditionIndex, promotion, lines, customerFacts } = params;

  switch (condition.field) {
    case 'cart.product': {
      const path = `offer.conditions[${conditionIndex}].value.productName`;
      const productId = promotion.menuItemIdByPath[path];
      // Sin vínculo confirmado no hay nada que evaluar: el gate de activación
      // ya lo exige, pero una promo vieja podría no tenerlo.
      if (!productId) return { met: false, missing: null };

      const required = condition.value.quantity ?? 1;
      const present = unitsOfProduct(lines, productId);
      if (compare(present, condition.operator, required)) return { met: true };

      // Solo `gte`/`gt` son "desbloqueables": a `eq` no se llega sumando.
      if (condition.operator === 'eq' || present > required) {
        return { met: false, missing: null };
      }
      const target = condition.operator === 'gt' ? required + 1 : required;
      return {
        met: false,
        missing: {
          kind: 'product',
          productId,
          productName: condition.value.productName,
          units: target - present,
        },
      };
    }

    case 'cart.subtotal': {
      const total = itemsTotalOf(lines);
      if (compare(total, condition.operator, condition.value)) return { met: true };
      if (condition.operator === 'lte' || condition.operator === 'lt') {
        // "En pedidos de menos de $X": sumar aleja, no acerca.
        return { met: false, missing: null };
      }
      const target =
        condition.operator === 'gt' ? condition.value + 0.01 : condition.value;
      return {
        met: false,
        missing: { kind: 'subtotal', amount: round2(target - total) },
      };
    }

    case 'cart.itemCount': {
      const count = unitCountOf(lines);
      return compare(count, condition.operator, condition.value)
        ? { met: true }
        : { met: false, missing: null };
    }

    case 'order.isFirstPurchase': {
      return customerFacts.isFirstPurchase === condition.value
        ? { met: true }
        : { met: false, missing: null };
    }
  }
};

// ---------------------------------------------------------------------------
// Beneficios
// ---------------------------------------------------------------------------

/** Precios unitarios individuales de un producto, de más barato a más caro. */
const unitPricesOfProduct = (
  lines: EvaluatorCartLine[],
  productId: string
): number[] => {
  const prices: number[] = [];
  for (const line of lines) {
    if (line.productId !== productId) continue;
    for (let i = 0; i < line.quantity; i += 1) prices.push(line.unitPrice);
  }
  return prices.sort((a, b) => a - b);
};

const benefitProductId = (
  promotion: EvaluatorPromotion,
  benefit: Benefit
): string | null => {
  if (benefit.type === 'nth_free' || benefit.type === 'free_product') {
    return promotion.menuItemIdByPath['offer.benefit.productName'] ?? null;
  }
  if ('target' in benefit && benefit.target?.scope === 'product') {
    return promotion.menuItemIdByPath['offer.benefit.target.productName'] ?? null;
  }
  return null;
};

type BenefitOutcome = {
  monetaryDiscount: number;
  freeShipping: boolean;
  gift: GiftItem | null;
  savingValue: number;
  summary: string;
};

const noBenefit: BenefitOutcome = {
  monetaryDiscount: 0,
  freeShipping: false,
  gift: null,
  savingValue: 0,
  summary: '',
};

const computeBenefit = (params: {
  promotion: EvaluatorPromotion;
  lines: EvaluatorCartLine[];
  deliveryFee: number;
  /** Precio de catálogo del producto regalado, si se conoce. */
  giftUnitPrice: number | null;
}): BenefitOutcome => {
  const { promotion, lines, deliveryFee, giftUnitPrice } = params;
  const benefit = promotion.offer.benefit;
  if (!benefit) return noBenefit;

  const itemsTotal = itemsTotalOf(lines);
  const productId = benefitProductId(promotion, benefit);

  switch (benefit.type) {
    case 'percentage_discount': {
      if (benefit.target?.scope === 'product') {
        if (!productId) return noBenefit;
        const prices = unitPricesOfProduct(lines, productId);
        // D12: cuando el beneficio alcanza a N unidades, las más baratas.
        const scoped = benefit.target.units ? prices.slice(0, benefit.target.units) : prices;
        const discount = round2(
          scoped.reduce((acc, price) => acc + (price * benefit.value) / 100, 0)
        );
        return {
          ...noBenefit,
          monetaryDiscount: discount,
          savingValue: discount,
          summary: `${benefit.value}% en ${benefit.target.productName}`,
        };
      }
      const discount = round2((itemsTotal * benefit.value) / 100);
      return {
        ...noBenefit,
        monetaryDiscount: discount,
        savingValue: discount,
        summary: `${benefit.value}% del pedido`,
      };
    }

    case 'fixed_discount': {
      if (benefit.target?.scope === 'product') {
        if (!productId) return noBenefit;
        const productTotal = round2(
          unitPricesOfProduct(lines, productId).reduce((acc, price) => acc + price, 0)
        );
        const discount = Math.min(benefit.value, productTotal);
        return {
          ...noBenefit,
          monetaryDiscount: round2(discount),
          savingValue: round2(discount),
          summary: `$${benefit.value} en ${benefit.target.productName}`,
        };
      }
      const discount = Math.min(benefit.value, itemsTotal);
      return {
        ...noBenefit,
        monetaryDiscount: round2(discount),
        savingValue: round2(discount),
        summary: `$${benefit.value} de descuento`,
      };
    }

    case 'fixed_price': {
      if (benefit.target?.scope === 'product') {
        if (!productId) return noBenefit;
        const prices = unitPricesOfProduct(lines, productId);
        const scoped = benefit.target.units ? prices.slice(0, benefit.target.units) : prices;
        const discount = round2(
          scoped.reduce((acc, price) => acc + Math.max(0, price - benefit.value), 0)
        );
        return {
          ...noBenefit,
          monetaryDiscount: discount,
          savingValue: discount,
          summary: `${benefit.target.productName} a $${benefit.value}`,
        };
      }
      const discount = round2(Math.max(0, itemsTotal - benefit.value));
      return {
        ...noBenefit,
        monetaryDiscount: discount,
        savingValue: discount,
        summary: `pedido a $${benefit.value}`,
      };
    }

    case 'nth_free': {
      if (!productId) return noBenefit;
      const prices = unitPricesOfProduct(lines, productId);
      const groups = benefit.repeats
        ? Math.floor(prices.length / benefit.buyQuantity)
        : prices.length >= benefit.buyQuantity
          ? 1
          : 0;
      const freeUnits = Math.min(groups * benefit.freeQuantity, prices.length);
      if (freeUnits <= 0) return noBenefit;
      // D12: se regalan las unidades MÁS BARATAS, valuadas al precio efectivo
      // (post descuento de catálogo). Valuarlas a precio de lista descontaría
      // más de lo que se cobró.
      const discount = round2(
        prices.slice(0, freeUnits).reduce((acc, price) => acc + price, 0)
      );
      const paid = benefit.buyQuantity - benefit.freeQuantity;
      return {
        ...noBenefit,
        monetaryDiscount: discount,
        savingValue: discount,
        summary: `${benefit.buyQuantity}x${paid} en ${benefit.productName} (${freeUnits} gratis)`,
      };
    }

    case 'free_product': {
      if (!productId) return noBenefit;
      const value = round2((giftUnitPrice ?? 0) * benefit.quantity);
      return {
        ...noBenefit,
        // D3: el regalo NO descuenta dinero — se materializa como línea a $0.
        gift: {
          promotionId: promotion.id,
          productId,
          productName: benefit.productName,
          quantity: benefit.quantity,
          estimatedValue: value,
        },
        savingValue: value,
        summary: `${benefit.quantity} × ${benefit.productName} de regalo`,
      };
    }

    case 'free_shipping': {
      return {
        ...noBenefit,
        freeShipping: true,
        savingValue: round2(deliveryFee),
        summary: 'envío gratis',
      };
    }
  }
};

// ---------------------------------------------------------------------------
// Selección (D4: clases disjuntas + desempate estable)
// ---------------------------------------------------------------------------

type Candidate = {
  promotion: EvaluatorPromotion;
  benefitClass: BenefitClass;
  outcome: BenefitOutcome;
};

const bySavingThenExpiryThenId = (a: Candidate, b: Candidate): number => {
  if (b.outcome.savingValue !== a.outcome.savingValue) {
    return b.outcome.savingValue - a.outcome.savingValue;
  }
  const aEnds = a.promotion.endsAt ? Date.parse(a.promotion.endsAt) : Number.MAX_SAFE_INTEGER;
  const bEnds = b.promotion.endsAt ? Date.parse(b.promotion.endsAt) : Number.MAX_SAFE_INTEGER;
  if (aEnds !== bEnds) return aEnds - bEnds;
  return a.promotion.id.localeCompare(b.promotion.id);
};

const byUnlockableRank = (a: UnlockablePromotion, b: UnlockablePromotion): number =>
  b.estimatedSaving - a.estimatedSaving || a.promotionId.localeCompare(b.promotionId);

// ---------------------------------------------------------------------------
// Entrada principal
// ---------------------------------------------------------------------------

export type EvaluateOptions = {
  /** Envío vigente, para valuar `free_shipping`. */
  deliveryFee?: number;
  /** Precio de catálogo por producto, para valuar regalos y desbloqueables. */
  catalogPriceByProductId?: Record<string, number>;
};

export const evaluatePromotions = (
  input: EvaluatePromotionsInput,
  options: EvaluateOptions = {}
): PromotionEvaluation => {
  const { cartLines, promotions, customerFacts, now, timezone } = input;
  const deliveryFee = options.deliveryFee ?? 0;
  const catalogPrices = options.catalogPriceByProductId ?? {};
  const itemsTotal = itemsTotalOf(cartLines);

  if (cartLines.length === 0 || promotions.length === 0) {
    return emptyPromotionEvaluation(itemsTotal);
  }

  const applicable: Candidate[] = [];
  const unlockable: UnlockablePromotion[] = [];

  for (const promotion of promotions) {
    if (!promotion.offer.benefit) continue;
    if (!isPromotionInValidityWindow(promotion, now, timezone)) continue;

    // Toda condición debe ser evaluable; si alguna no lo es, la promo no
    // aplica (y el llamador la loguea). Nunca se "interpreta" en caliente.
    const conditions: EvaluableCondition[] = [];
    let hasUnevaluable = false;
    for (const raw of promotion.offer.conditions) {
      const parsed = toEvaluableCondition(raw);
      if (!parsed) {
        hasUnevaluable = true;
        break;
      }
      conditions.push(parsed);
    }
    if (hasUnevaluable) continue;

    const unmet: Array<UnlockablePromotion['missing'] | null> = [];
    conditions.forEach((condition, conditionIndex) => {
      const outcome = evaluateCondition({
        condition,
        conditionIndex,
        promotion,
        lines: cartLines,
        customerFacts,
      });
      if (!outcome.met) unmet.push(outcome.missing);
    });

    if (unmet.length === 0) {
      const giftPath = promotion.menuItemIdByPath['offer.benefit.productName'];
      const outcome = computeBenefit({
        promotion,
        lines: cartLines,
        deliveryFee,
        giftUnitPrice: giftPath ? (catalogPrices[giftPath] ?? null) : null,
      });
      if (outcome.savingValue > 0 || outcome.gift) {
        applicable.push({
          promotion,
          benefitClass: benefitClassOf(promotion.offer.benefit),
          outcome,
        });
      }
      continue;
    }

    // Desbloqueable: falta exactamente UNA condición y es alcanzable sumando.
    if (unmet.length === 1 && unmet[0]) {
      const missing = unmet[0];
      const estimated = estimateUnlockedSaving({
        promotion,
        lines: cartLines,
        missing,
        deliveryFee,
        catalogPrices,
      });
      if (estimated > 0) {
        unlockable.push({
          promotionId: promotion.id,
          name: promotion.name,
          benefitType: promotion.offer.benefit.type,
          benefitClass: benefitClassOf(promotion.offer.benefit),
          missing,
          estimatedSaving: estimated,
          relatedProductIds: Object.values(promotion.menuItemIdByPath),
          summary:
            missing.kind === 'product'
              ? `sumando ${missing.units} × ${missing.productName}`
              : `sumando $${missing.amount} más`,
        });
      }
    }
  }

  // Una ganadora por clase (D4).
  const winners: Candidate[] = [];
  for (const benefitClass of ['monetary', 'shipping', 'gift'] as const) {
    const best = applicable
      .filter((candidate) => candidate.benefitClass === benefitClass)
      .sort(bySavingThenExpiryThenId)[0];
    if (best) winners.push(best);
  }

  // Cerrojo exclusivo: si alguna ganadora no admite combinarse, queda sola.
  const exclusive = winners
    .filter((candidate) => candidate.promotion.offer.stacking?.allowed === false)
    .sort(bySavingThenExpiryThenId)[0];
  const finalWinners = exclusive ? [exclusive] : winners;

  const applied: AppliedPromotion[] = finalWinners.map((candidate) => ({
    promotionId: candidate.promotion.id,
    name: candidate.promotion.name,
    benefitType: candidate.promotion.offer.benefit!.type,
    benefitClass: candidate.benefitClass,
    monetaryDiscount: candidate.outcome.monetaryDiscount,
    savingValue: candidate.outcome.savingValue,
    summary: candidate.outcome.summary,
    offerSnapshot: candidate.promotion.offer,
  }));

  // Tope: el total de ítems nunca queda negativo.
  const monetaryDiscount = Math.min(
    round2(applied.reduce((acc, item) => acc + item.monetaryDiscount, 0)),
    itemsTotal
  );

  return {
    applied,
    unlockable: unlockable.sort(byUnlockableRank),
    monetaryDiscount: round2(monetaryDiscount),
    freeShipping: finalWinners.some((candidate) => candidate.outcome.freeShipping),
    giftItems: finalWinners
      .map((candidate) => candidate.outcome.gift)
      .filter((gift): gift is GiftItem => gift !== null),
    itemsTotal,
  };
};

/**
 * Ahorro estimado si el cliente completa lo que falta. Se calcula sobre un
 * carrito hipotético — nunca se escribe nada.
 */
const estimateUnlockedSaving = (params: {
  promotion: EvaluatorPromotion;
  lines: EvaluatorCartLine[];
  missing: UnlockablePromotion['missing'];
  deliveryFee: number;
  catalogPrices: Record<string, number>;
}): number => {
  const { promotion, lines, missing, deliveryFee, catalogPrices } = params;

  const hypothetical: EvaluatorCartLine[] = [...lines];
  if (missing.kind === 'product') {
    const price =
      catalogPrices[missing.productId] ??
      lines.find((line) => line.productId === missing.productId)?.unitPrice ??
      0;
    hypothetical.push({
      productId: missing.productId,
      productName: missing.productName,
      quantity: missing.units,
      unitPrice: price,
      variation: null,
    });
  }
  // `subtotal`: no sabemos qué sumaría el cliente; se valúa con el carrito
  // actual, que subestima el beneficio. Preferimos subestimar que prometer.

  const giftPath = promotion.menuItemIdByPath['offer.benefit.productName'];
  const outcome = computeBenefit({
    promotion,
    lines: hypothetical,
    deliveryFee,
    giftUnitPrice: giftPath ? (catalogPrices[giftPath] ?? null) : null,
  });
  return outcome.savingValue;
};
