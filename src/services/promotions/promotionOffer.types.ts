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

export type Benefit =
  | { type: 'percentage_discount'; value: number }
  | { type: 'fixed_discount'; value: number }
  | { type: 'fixed_price'; value: number }
  | { type: 'free_product'; productName: string; quantity: number }
  | { type: 'free_shipping' };

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
