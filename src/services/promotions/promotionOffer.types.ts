/**
 * Contrato interno V1 para promociones interpretadas desde lenguaje natural.
 * No es aún el modelo de persistencia — se valida con casos reales antes de congelarlo.
 */

export type ConditionOperator =
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  | 'contains';

export type Condition = {
  field: string;
  operator: ConditionOperator;
  value: unknown;
};

/**
 * Vocabulario CERRADO de condiciones evaluables (D1).
 *
 * Hasta esta fase la whitelist vivía solo en el prompt del intérprete
 * (`src/prompts/promotionInterpreter.ts`) mientras `Condition.field` aceptaba
 * cualquier string — una regla transaccional viviendo en un prompt (V-05).
 * Acá pasa a ser tipo, y `promotionConditions.ts` la valida en el borde.
 *
 * `Condition` sigue siendo la forma de ALMACENAMIENTO (permisiva): las filas
 * ya persistidas no se migran (el `offer` es JSONB, D1 del plan de
 * persistencia). Lo que se cierra es qué se puede ACTIVAR y qué se evalúa.
 */
export const CONDITION_FIELDS = [
  'cart.product',
  'cart.subtotal',
  'cart.itemCount',
  'order.isFirstPurchase',
] as const;

export type ConditionField = (typeof CONDITION_FIELDS)[number];

/** Valor de `cart.product`: el vínculo real al menú es `promotion_product`. */
export type ProductConditionValue = {
  productName: string;
  quantity?: number;
};

/**
 * Condición ya validada contra la whitelist: campo conocido, operador
 * permitido para ese campo y `value` con la forma correcta.
 */
export type EvaluableCondition =
  | {
      field: 'cart.product';
      operator: 'gte' | 'gt' | 'eq';
      value: ProductConditionValue;
    }
  | {
      field: 'cart.subtotal';
      operator: 'gte' | 'gt' | 'lte' | 'lt';
      value: number;
    }
  | {
      field: 'cart.itemCount';
      operator: 'gte' | 'gt' | 'eq';
      value: number;
    }
  | {
      field: 'order.isFirstPurchase';
      operator: 'eq';
      value: boolean;
    };

/**
 * Sobre qué se aplica un beneficio monetario (D2).
 *
 * Sin esto, `{ type: 'percentage_discount', value: 50 }` no distingue
 * "50% del pedido" de "50% de la segunda unidad" — el mismo JSON con dos
 * montos distintos.
 */
export type BenefitTarget =
  | { scope: 'order' }
  | { scope: 'product'; productName: string; units?: number };

export type Benefit =
  | { type: 'percentage_discount'; value: number; target?: BenefitTarget }
  | { type: 'fixed_discount'; value: number; target?: BenefitTarget }
  | { type: 'fixed_price'; value: number; target?: BenefitTarget }
  /**
   * Compra N, llevás M gratis: 2x1, 3x2, buy 2 get 1 (D2).
   * `free_product` NO sirve para esto: significa "regalo de OTRO producto",
   * y con el mismo producto de la condición el JSON queda ambiguo entre
   * "una de las 2 sale gratis" y "te regalo una 3ª".
   */
  | {
      type: 'nth_free';
      productName: string;
      buyQuantity: number;
      freeQuantity: number;
      /** true = escala con el carrito (6 unidades en 2x1 → 3 gratis). */
      repeats: boolean;
    }
  | { type: 'free_product'; productName: string; quantity: number }
  | { type: 'free_shipping' };

/** Beneficios que reducen el precio de lo que ya está en el carrito (D3). */
export const MONETARY_BENEFIT_TYPES = [
  'percentage_discount',
  'fixed_discount',
  'fixed_price',
  'nth_free',
] as const;

export type MonetaryBenefitType = (typeof MONETARY_BENEFIT_TYPES)[number];

/** Clase de recurso para el stacking por clases disjuntas (D4). */
export type BenefitClass = 'monetary' | 'shipping' | 'gift';

export const benefitClassOf = (benefit: Benefit): BenefitClass => {
  if (benefit.type === 'free_shipping') return 'shipping';
  if (benefit.type === 'free_product') return 'gift';
  return 'monetary';
};

export type OfferValidity = {
  startsAt?: string;
  endsAt?: string;
  /** 0=domingo … 6=sábado (igual que `Date.getDay()`). Martes = 2. */
  daysOfWeek?: number[];
  timeRange?: {
    from: string;
    to: string;
  };
};

export type OfferLimits = {
  maxUsesTotal?: number;
  maxUsesPerCustomer?: number;
};

export type OfferStacking = {
  allowed: boolean;
};

export type StructuredOffer = {
  name: string;
  conditions: Condition[];
  /** Ausente solo cuando falta el beneficio y status = needs_clarification. */
  benefit?: Benefit | null;
  validity?: OfferValidity;
  limits?: OfferLimits;
  stacking?: OfferStacking;
};

export type MissingInformation = {
  field: string;
  question: string;
};

export type UnresolvedEntity = {
  type: 'product' | 'category' | 'other';
  text: string;
  path: string;
};

/** Platillo real del menú propuesto para un nombre que dijo el dueño. */
export type PromotionEntityCandidate = {
  menuItemId: string;
  name: string;
  thumbnailUrl: string | null;
  price: number | null;
  currencyCode: string | null;
  /** 0–1, mayor = mejor match. */
  score: number;
  source: 'exact' | 'contains' | 'semantic';
  /** Variación del platillo que matcheó, si el match vino por ahí. */
  matchedVariation: string | null;
};

/** Presentación lista para UI admin (no inventar labels en el front). */
export type PromotionEntityCard = {
  name: string;
  kind: 'product' | 'category' | 'other';
  icon: 'utensils' | 'tag' | 'circle-help';
  productId: string | null;
  thumbnailUrl: string | null;
  resolved: boolean;
  path: string;
  subtitle: string;
  /** Candidatos del menú para que el admin elija. Vacío si no se resolvió. */
  candidates: PromotionEntityCandidate[];
};

export type PromotionDisplayCondition = {
  label: string;
  index: number;
};

export type PromotionInterpretationDisplay = {
  statusLabel: string;
  benefitLabel: string | null;
  conditions: PromotionDisplayCondition[];
  validityLines: string[];
  stackingLabel: string | null;
  entityCards: PromotionEntityCard[];
};

export type PromotionInterpretationStatus = 'complete' | 'needs_clarification' | 'error';

export type PromotionInterpretationResult = {
  status: 'complete' | 'needs_clarification';
  offer: StructuredOffer;
  missingInformation: MissingInformation[];
  unresolvedEntities: UnresolvedEntity[];
  /** Capa amigable para el panel. Preferir esto sobre formatear `offer` a mano. */
  display: PromotionInterpretationDisplay;
};

/** Estados de una promoción persistida (D5). `archived` es terminal. */
export type PromotionStatus = 'draft' | 'active' | 'paused' | 'archived';

/** Vínculo confirmado por el admin entre un nombre del offer y un platillo. */
export type PromotionProductLink = {
  path: string;
  role: 'condition' | 'benefit';
  menuItemId: string;
  sourceText: string;
  quantity?: number | null;
};

export type PromotionProductDto = {
  menuItemId: string;
  name: string;
  thumbnailUrl: string | null;
  role: 'condition' | 'benefit';
  offerPath: string;
  sourceText: string;
  quantity: number | null;
};

export type PromotionDto = {
  id: string;
  name: string;
  status: PromotionStatus;
  statusLabel: string;
  offer: StructuredOffer;
  products: PromotionProductDto[];
  sourceType: 'text' | 'audio';
  sourceText: string | null;
  /** Línea única para pintar la fila del listado sin armar strings en el front. */
  summaryLine: string;
  display: PromotionInterpretationDisplay;
  createdAt: string;
  updatedAt: string;
};

export type PromotionInterpretationError = {
  status: 'error';
  code: 'VALIDATION_FAILED' | 'LLM_FAILED' | 'EMPTY_INPUT';
  message: string;
};

export type PromotionInterpretOutcome =
  | PromotionInterpretationResult
  | PromotionInterpretationError;
