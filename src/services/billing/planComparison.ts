/**
 * Orden parcial entre planes para decidir si un cambio es upgrade o
 * downgrade (Fase 2, sección 8). El código anterior comparaba
 * exclusivamente `monthly_price_usd` — eso alcanza mientras todos los
 * planes comparten las mismas capacidades (hoy: `basic`/`pro`/`business`,
 * los tres con `ai_enabled=true` y `shopping_enabled=true`), pero deja de
 * tener sentido en cuanto dos planes difieren en QUÉ ofrecen, no solo en
 * cuánta cuota — como `shopping_only` (`ai_enabled=false`), donde "cuesta
 * menos" no es lo mismo que "es estrictamente menos plan".
 *
 * Un plan A domina a un plan B si A da al menos lo mismo que B en cada eje
 * de capacidad (`ai_enabled`, `shopping_enabled`, `token_limit`) y el
 * precio de A es mayor o igual al de B. Si A domina a B (y no son
 * idénticos), A es upgrade respecto de B. Si ninguno domina al otro —
 * capacidades en direcciones opuestas, o capacidades y precio en
 * direcciones opuestas — no hay un orden definido entre ambos, y
 * `comparePlans` lo señala explícitamente en vez de inventar uno a partir
 * del precio solo.
 */

export type ComparablePlan = {
  code: string;
  monthly_price_usd: unknown;
  ai_enabled: boolean;
  shopping_enabled: boolean;
  token_limit: number;
};

export type PlanComparison = "a_is_upgrade" | "b_is_upgrade" | "equal" | "ambiguous";

function priceOf(plan: ComparablePlan): number {
  const raw = plan.monthly_price_usd;
  const n = raw == null ? 0 : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** `true` si `a` da, en cada eje, al menos lo mismo que `b` (dominancia débil). */
function weaklyDominates(a: ComparablePlan, b: ComparablePlan): boolean {
  return (
    (a.ai_enabled || !b.ai_enabled) &&
    (a.shopping_enabled || !b.shopping_enabled) &&
    a.token_limit >= b.token_limit
  );
}

function capabilitiesEqual(a: ComparablePlan, b: ComparablePlan): boolean {
  return (
    a.ai_enabled === b.ai_enabled &&
    a.shopping_enabled === b.shopping_enabled &&
    a.token_limit === b.token_limit
  );
}

export function comparePlans(a: ComparablePlan, b: ComparablePlan): PlanComparison {
  const priceA = priceOf(a);
  const priceB = priceOf(b);

  if (capabilitiesEqual(a, b)) {
    if (priceA === priceB) return "equal";
    return priceA > priceB ? "a_is_upgrade" : "b_is_upgrade";
  }

  const aDominates = weaklyDominates(a, b);
  const bDominates = weaklyDominates(b, a);

  // Mismo plan en todo menos el precio no debería pasar con capacidades
  // distintas (`capabilitiesEqual` ya lo descartó), así que acá `aDominates`
  // y `bDominates` nunca son ambos verdaderos.
  if (aDominates && priceA >= priceB) return "a_is_upgrade";
  if (bDominates && priceB >= priceA) return "b_is_upgrade";

  // O ninguno domina al otro (capacidades en direcciones opuestas), o uno
  // domina en capacidades pero el precio va en contra — en ambos casos no
  // hay una relación de orden segura entre estos dos planes.
  return "ambiguous";
}
