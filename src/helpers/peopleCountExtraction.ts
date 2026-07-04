/**
 * Cantidad de personas solo con dígitos (sin LLM).
 * Acepta únicamente el número tal cual lo escribe el usuario (1–99), p. ej. "4" o "12".
 * Cualquier texto extra dispara reintento con mensaje de validación.
 */
export function extractStrictNumericPeopleCount(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = parseInt(t, 10);
  if (n >= 1 && n <= 99) return n;
  return null;
}

/** Party size desde respuesta en lenguaje natural (sin gate de solo dígitos). */
export function resolvePartySizeFromReply(
  text: string,
  detectionQuantity: number | null | undefined
): number | null {
  if (
    detectionQuantity != null &&
    detectionQuantity >= 1 &&
    detectionQuantity <= 99
  ) {
    return Math.floor(detectionQuantity);
  }

  const strict = extractStrictNumericPeopleCount(text);
  if (strict != null) return strict;

  const t = text.trim();
  const patterns = [
    /\b(?:somos|éramos|eramos|para|van|vamos)\s+(?:a\s+ser\s+)?(\d{1,2})\b/i,
    /\b(\d{1,2})\s+personas?\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 99) return n;
  }

  return null;
}
