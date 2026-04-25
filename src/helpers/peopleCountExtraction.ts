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
