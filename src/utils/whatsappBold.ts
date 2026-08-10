/**
 * Negrita WhatsApp Business: un solo `*` a cada lado (`*así*`).
 * Markdown (`**así**`) o anidar `*...*...*` deja asteriscos visibles en el chat.
 */

/** Quita todos los `*` (para títulos/atajos que el builder vuelve a envolver una sola vez). */
export function stripWhatsAppBoldMarkers(text: string): string {
  return text.replace(/\*+/g, '').replace(/\s+/g, ' ').trim();
}

/** Envuelve en negrita WA una sola vez (idempotente si ya venía con `*`). */
export function wrapWhatsAppBold(text: string): string {
  const plain = stripWhatsAppBoldMarkers(text);
  if (!plain) return '';
  return `*${plain}*`;
}

/**
 * Normaliza marcas de negrita en texto libre (LLM / bodies):
 * - `**x**` (Markdown) → `*x*`
 * - colapsa runs `***` / `****`
 * - aplana envoltorios dobles `**x**` ya cubiertos; también `* *x* *` → `*x*`
 */
export function normalizeWhatsAppBoldMarkers(text: string): string {
  let out = text;

  // Markdown bold → WhatsApp bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '*$1*');

  // Doble envoltorio con espacios: * *texto* * → *texto*
  out = out.replace(/\*\s*\*([^*]+)\*\s*\*/g, '*$1*');

  // Runs residuales de 3+ asteriscos
  out = out.replace(/\*{3,}/g, '*');

  // Pares `**` sueltos que quedaron
  out = out.replace(/\*\*/g, '*');

  return out;
}
