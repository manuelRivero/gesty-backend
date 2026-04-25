import type { MenuCategoryTag } from '@prisma/client';
import type { RecommendationCartSummary } from './recommendationCartSummary';

/** Fases del flujo tipo mozo después de fijar comensales. */
export type NextActionFlowPhase =
  | 'MAIN_INCOMPLETE'
  | 'DRINK'
  | 'STARTER'
  | 'DESSERT'
  | 'CHECKOUT'
  /** Sin peopleCount o flujo no aplica: no forzar categoría. */
  | 'BROWSE';

export type NextActionHintKey = 'DRINK' | 'STARTER' | 'DESSERT' | 'CHECKOUT';

export type NextActionHintsShown = Partial<Record<NextActionHintKey, boolean>>;

/**
 * Orden fijo: bebida → entrada → postre → cierre.
 * Cobertura por categoría = unidades en borrador (buildRecommendationCartSummary).
 */
export function resolveNextActionFlowPhase(params: {
  peopleCount: number | null;
  mainCoverage: number;
  cartSummary: RecommendationCartSummary;
}): NextActionFlowPhase {
  const pc = params.peopleCount;
  if (pc == null || pc <= 0) return 'BROWSE';

  if (params.mainCoverage < pc) return 'MAIN_INCOMPLETE';

  const cs = params.cartSummary;
  if (cs.drinks === 0) return 'DRINK';
  if (cs.starters === 0) return 'STARTER';
  if (cs.desserts === 0) return 'DESSERT';
  return 'CHECKOUT';
}

/** Tag a filtrar en el catálogo; null = sin filtro por categoría. */
export function forcedCategoryTagForFlowPhase(
  phase: NextActionFlowPhase
): MenuCategoryTag | null {
  switch (phase) {
    case 'MAIN_INCOMPLETE':
      return 'MAIN';
    case 'DRINK':
      return 'DRINK';
    case 'STARTER':
      return 'STARTER';
    case 'DESSERT':
      return 'DESSERT';
    default:
      return null;
  }
}

/**
 * Banners de texto antes de la lista de resultados: desactivados (UX: solo listado, sin frases de
 * seguimiento). El filtrado por categoría sigue vía {@link resolveNextActionFlowPhase} y
 * {@link forcedCategoryTagForFlowPhase}.
 */
/** Tras agregar ítem no principal con MAIN aún incompleto (post-carrito, sin bloquear). */
export function acknowledgeNonMainAddLine(
  tag: MenuCategoryTag
): string | null {
  switch (tag) {
    case 'STARTER':
      return 'Perfecto, sumamos la entrada 👌';
    case 'DRINK':
      return 'Perfecto, sumamos la bebida 👌';
    case 'DESSERT':
      return 'Perfecto, sumamos el postre 👌';
    default:
      return null;
  }
}

/** Tras agregar ítem (MAIN u otro) cuando aún falta cobertura de principales vs N personas. */
export const GUIDE_CHOOSE_MAINS_AFTER_NON_MAIN =
  'Si querés, podés seguir con platos principales para el grupo 👌';

export function getNextActionBannerMessage(
  _phase: NextActionFlowPhase,
  _hintsShown: NextActionHintsShown | null | undefined
): { message: string | null; hintKey: NextActionHintKey | null } {
  void _phase;
  void _hintsShown;
  return { message: null, hintKey: null };
}
