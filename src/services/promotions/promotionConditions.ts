/**
 * Gate de evaluabilidad del DSL de condiciones y beneficios (D1 / D2).
 *
 * Por qué existe: hasta esta fase la whitelist de `Condition.field` vivía solo
 * en el prompt del intérprete mientras el schema aceptaba `z.string()`. Una
 * promoción con `field: "cart.total_after_discount"` pasaba Zod, pasaba
 * `assertPromotionComplete` y se podía ACTIVAR — el dueño la creía viva y
 * nunca se aplicaba, sin ninguna señal. Es el patrón de V-05 (reglas
 * transaccionales viviendo en prompts) y ADR-0002 lo manda al borde.
 *
 * Este módulo es puro: no toca base ni LLM. Se usa en dos bordes distintos:
 * - activación (`promotionStatus.assertPromotionActivatable`) → error tipado
 * - runtime (`evaluatePromotions`) → la promo no aplica y se loguea
 */

import {
  CONDITION_FIELDS,
  MONETARY_BENEFIT_TYPES,
  type Benefit,
  type Condition,
  type ConditionField,
  type ConditionOperator,
  type EvaluableCondition,
  type ProductConditionValue,
  type StructuredOffer,
} from './promotionOffer.types';

/** Operadores con semántica definida para cada campo. El resto se rechaza. */
const ALLOWED_OPERATORS: Record<ConditionField, ReadonlyArray<ConditionOperator>> = {
  'cart.product': ['gte', 'gt', 'eq'],
  'cart.subtotal': ['gte', 'gt', 'lte', 'lt'],
  'cart.itemCount': ['gte', 'gt', 'eq'],
  'order.isFirstPurchase': ['eq'],
};

const isConditionField = (field: string): field is ConditionField =>
  (CONDITION_FIELDS as ReadonlyArray<string>).includes(field);

export const parseProductConditionValue = (
  value: unknown
): ProductConditionValue | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as { productName?: unknown; quantity?: unknown };
  if (typeof v.productName !== 'string' || !v.productName.trim()) return null;
  if (v.quantity !== undefined) {
    if (typeof v.quantity !== 'number' || !Number.isInteger(v.quantity) || v.quantity < 1) {
      return null;
    }
  }
  return {
    productName: v.productName.trim(),
    ...(typeof v.quantity === 'number' ? { quantity: v.quantity } : {}),
  };
};

const isPositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const isPositiveInteger = (value: unknown): value is number =>
  isPositiveNumber(value) && Number.isInteger(value);

/**
 * Narrowing de una condición de almacenamiento a una evaluable.
 * `null` = no evaluable (campo desconocido, operador sin semántica para ese
 * campo, o `value` con la forma equivocada).
 */
export const toEvaluableCondition = (
  condition: Condition
): EvaluableCondition | null => {
  const { field, operator, value } = condition;
  if (typeof field !== 'string' || !isConditionField(field)) return null;
  if (!ALLOWED_OPERATORS[field].includes(operator)) return null;

  switch (field) {
    case 'cart.product': {
      const parsed = parseProductConditionValue(value);
      if (!parsed) return null;
      return {
        field,
        operator: operator as 'gte' | 'gt' | 'eq',
        value: parsed,
      };
    }
    case 'cart.subtotal': {
      if (!isPositiveNumber(value)) return null;
      return { field, operator: operator as 'gte' | 'gt' | 'lte' | 'lt', value };
    }
    case 'cart.itemCount': {
      if (!isPositiveInteger(value)) return null;
      return { field, operator: operator as 'gte' | 'gt' | 'eq', value };
    }
    case 'order.isFirstPurchase': {
      if (typeof value !== 'boolean') return null;
      return { field, operator: 'eq', value };
    }
  }
};

export const isEvaluableCondition = (condition: Condition): boolean =>
  toEvaluableCondition(condition) !== null;

/** Motivo legible de por qué una condición no se puede evaluar. */
export const describeConditionProblem = (condition: Condition): string | null => {
  const field = typeof condition.field === 'string' ? condition.field : '(sin campo)';
  if (typeof condition.field !== 'string' || !isConditionField(condition.field)) {
    return `La condición usa un campo no soportado ("${field}"). Campos válidos: ${CONDITION_FIELDS.join(', ')}`;
  }
  if (!ALLOWED_OPERATORS[condition.field].includes(condition.operator)) {
    return `El operador "${condition.operator}" no tiene semántica para "${field}". Operadores válidos: ${ALLOWED_OPERATORS[condition.field].join(', ')}`;
  }
  if (toEvaluableCondition(condition) === null) {
    return `El valor de la condición sobre "${field}" no tiene la forma esperada`;
  }
  return null;
};

/**
 * Problemas del beneficio que impiden evaluarlo de forma determinista (D2).
 * No incluye "falta beneficio": eso es completitud y ya lo cubre
 * `assertPromotionComplete`.
 */
export const describeBenefitProblems = (benefit: Benefit): string[] => {
  const problems: string[] = [];

  const isMonetary = (MONETARY_BENEFIT_TYPES as ReadonlyArray<string>).includes(
    benefit.type
  );

  // `nth_free` lleva su propio producto: no necesita target.
  if (isMonetary && benefit.type !== 'nth_free') {
    const target = (benefit as { target?: { scope?: string } }).target;
    if (!target) {
      problems.push(
        `Falta indicar sobre qué se aplica el beneficio (pedido completo o un platillo). ` +
          `Sin eso, "${benefit.type}" es ambiguo`
      );
    } else if (target.scope === 'product') {
      const productName = (target as { productName?: unknown }).productName;
      if (typeof productName !== 'string' || !productName.trim()) {
        problems.push('El beneficio apunta a un platillo pero no dice cuál');
      }
    }
  }

  if (benefit.type === 'nth_free') {
    if (!Number.isInteger(benefit.buyQuantity) || benefit.buyQuantity < 2) {
      problems.push('En un 2x1 / 3x2 hay que comprar al menos 2 unidades');
    }
    if (!Number.isInteger(benefit.freeQuantity) || benefit.freeQuantity < 1) {
      problems.push('La cantidad gratis tiene que ser al menos 1');
    }
    if (
      Number.isInteger(benefit.buyQuantity) &&
      Number.isInteger(benefit.freeQuantity) &&
      benefit.freeQuantity >= benefit.buyQuantity
    ) {
      problems.push(
        'La cantidad gratis tiene que ser menor que la comprada (si no, todo sale gratis)'
      );
    }
  }

  return problems;
};

/**
 * Ambigüedad de `free_product` (D2): si el producto "regalado" resuelve al
 * mismo `menu_item` que una condición, el JSON no distingue "una de las 2 que
 * compraste sale gratis" de "te regalo una 3ª". Se pide reexpresarla como
 * `nth_free` en vez de adivinar cuál quiso decir el dueño.
 */
export const findAmbiguousGift = (params: {
  offer: StructuredOffer;
  /** menu_item vinculado por `offer_path`, tal como lo confirmó el admin. */
  menuItemIdByPath: Map<string, string>;
}): string | null => {
  const { offer, menuItemIdByPath } = params;
  if (offer.benefit?.type !== 'free_product') return null;

  const giftItemId = menuItemIdByPath.get('offer.benefit.productName');
  if (!giftItemId) return null;

  for (let index = 0; index < offer.conditions.length; index += 1) {
    const path = `offer.conditions[${index}].value.productName`;
    if (menuItemIdByPath.get(path) === giftItemId) {
      return (
        `El regalo es el mismo platillo que activa la promoción: no se sabe si ` +
        `una de las compradas sale gratis o si se agrega una unidad extra. ` +
        `Expresala como 2x1 / 3x2 (nth_free)`
      );
    }
  }

  return null;
};

/** Todas las condiciones no evaluables de una oferta, con su motivo. */
export const collectConditionProblems = (offer: StructuredOffer): string[] =>
  offer.conditions
    .map((condition) => describeConditionProblem(condition))
    .filter((problem): problem is string => problem !== null);

/**
 * Límites de uso declarados que ningún mecanismo puede hacer cumplir (B7):
 * no existe tabla de redenciones. Preferimos rechazar la activación antes que
 * aceptarla y no cumplirla.
 */
export const collectUnsupportedLimits = (offer: StructuredOffer): string[] => {
  const problems: string[] = [];
  if (offer.limits?.maxUsesTotal != null) {
    problems.push(
      'Todavía no podemos limitar el total de usos de una promoción (falta el registro de canjes)'
    );
  }
  if (offer.limits?.maxUsesPerCustomer != null) {
    problems.push(
      'Todavía no podemos limitar los usos por cliente (falta el registro de canjes)'
    );
  }
  return problems;
};
