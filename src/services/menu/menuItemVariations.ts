// Fuente única de verdad para normalizar, validar y matchear variaciones de
// nombre de un platillo (p. ej. Pizza → especial, roquefort, napolitana).
// Lógica pura: no depende de Prisma ni de WhatsApp, para que el flujo
// determinístico y el agente híbrido no se desincronicen (ver
// PLAN-ACCION-VARIACIONES-PLATILLOS.md, D6).

/**
 * Normaliza la lista que carga el admin: descarta vacíos, trimea y hace
 * dedupe case-insensitive conservando la primera grafía escrita (el admin
 * escribe "Roquefort", eso es lo que ve el cliente). Preserva el orden.
 */
export function normalizeVariationsInput(
  input: string[] | null | undefined,
): string[] {
  if (!input) return [];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of input) {
    const trimmed = raw.trim();
    if (!trimmed) continue;

    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

/** `variations.length > 0`. `[]` ≡ `null` ≡ "sin variaciones" (D1). */
export function hasVariations(item: { variations: string[] }): boolean {
  return item.variations.length > 0;
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

export type MatchVariationResult =
  | { status: 'ok'; value: string }
  | { status: 'not_found' }
  | { status: 'ambiguous'; candidates: string[] };

/**
 * Resuelve lo que escribió el cliente ("roquefor", "de Roquefort") contra la
 * lista de variaciones cargadas. Determinístico, sin LLM (D6): normaliza
 * (lowercase + sin acentos + trim + colapso de espacios), intenta match
 * exacto y si falla busca por inclusión. Devuelve la grafía original.
 */
export function matchVariation(
  input: string,
  variations: string[],
): MatchVariationResult {
  const normalizedInput = normalizeForMatch(input);
  if (!normalizedInput) return { status: 'not_found' };

  const normalizedVariations = variations.map((value) => ({
    value,
    normalized: normalizeForMatch(value),
  }));

  const exactMatch = normalizedVariations.find(
    (entry) => entry.normalized === normalizedInput,
  );
  if (exactMatch) return { status: 'ok', value: exactMatch.value };

  const partialMatches = normalizedVariations.filter(
    (entry) =>
      entry.normalized.includes(normalizedInput) ||
      normalizedInput.includes(entry.normalized),
  );

  if (partialMatches.length === 1) {
    return { status: 'ok', value: partialMatches[0].value };
  }
  if (partialMatches.length > 1) {
    return {
      status: 'ambiguous',
      candidates: partialMatches.map((entry) => entry.value),
    };
  }

  return { status: 'not_found' };
}

/** Resuelve el índice que viaja en el payload del picker (`:v<index>`). */
export function variationByIndex(
  variations: string[],
  index: number,
): string | null {
  return variations[index] ?? null;
}
