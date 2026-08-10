/**
 * Formato común para mensajes con lista interactiva + atajos en texto:
 * 1) intro / atajos en negrita (primero)
 * 2) alternativa: elegir de la lista WA
 */

export const LIST_AS_ALTERNATIVE_LINE = 'O elegí de la lista.';

/**
 * Arma el body: intro opcional → viñetas (atajos) → invitación a la lista.
 * `bulletLines` ya vienen formateadas (ej. "• *Menú*" o "• *Modificar* pedido").
 */
export function buildShortcutsThenListBody(
  intro: string,
  bulletLines: string[]
): string {
  const bullets = bulletLines.map((line) => line.trim()).filter(Boolean);
  const parts: string[] = [];
  const introTrim = intro.trim();

  if (introTrim) parts.push(introTrim);
  if (bullets.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(...bullets);
  }
  if (parts.length > 0) parts.push('');
  parts.push(LIST_AS_ALTERNATIVE_LINE);

  return parts.join('\n');
}

/** Viñeta de atajo con palabra clave en negrita. */
export function shortcutBullet(boldKey: string, rest = ''): string {
  const key = boldKey.trim();
  const suffix = rest.trim();
  return suffix ? `• *${key}* ${suffix}` : `• *${key}*`;
}
