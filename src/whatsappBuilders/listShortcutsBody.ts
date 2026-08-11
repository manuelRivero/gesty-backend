/**
 * Formato común para mensajes con lista interactiva + atajos en texto:
 * intro / atajos en negrita. El footer WA («Elegí o escribí») invita a la lista;
 * no repetir «O elegí de la lista.» en el body.
 */

import { stripWhatsAppBoldMarkers } from '../utils/whatsappBold';

/** @deprecated El footer WA ya invita a elegir/escribir; no usar en bodies nuevos. */
export const LIST_AS_ALTERNATIVE_LINE = 'O elegí de la lista.';

export const MANAGEMENT_CONTINUE_LINE =
  'O podés continuar con la gestión de tu pedido.';

/**
 * Arma el body: intro opcional → viñetas (atajos).
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

  return parts.join('\n');
}

/**
 * Body post-add / complemento: sugerencias de platos, luego gestión.
 * Evita mezclar upselles y acciones (Menú / Finalizar) en un solo bloque de viñetas.
 * Por defecto no agrega «O elegí de la lista.» (el footer WA ya invita).
 */
export function buildSuggestionsThenManagementThenListBody(params: {
  intro: string;
  suggestionBullets: string[];
  managementBullets: string[];
  managementIntro?: string;
  /**
   * Si true, agrega «O elegí de la lista.» al body.
   * Default false: el footer WA («Elegí o escribí») ya cubre esa invitación.
   */
  includeListAlternative?: boolean;
}): string {
  const introTrim = params.intro.trim();
  const suggestions = params.suggestionBullets
    .map((line) => line.trim())
    .filter(Boolean);
  const management = params.managementBullets
    .map((line) => line.trim())
    .filter(Boolean);
  const managementIntro = (
    params.managementIntro ?? MANAGEMENT_CONTINUE_LINE
  ).trim();
  const includeListAlternative = params.includeListAlternative === true;

  const parts: string[] = [];
  if (introTrim) parts.push(introTrim);
  if (suggestions.length > 0) {
    if (parts.length > 0) parts.push('');
    parts.push(...suggestions);
  }
  if (management.length > 0) {
    if (parts.length > 0) parts.push('');
    if (managementIntro) parts.push(managementIntro);
    if (managementIntro) parts.push('');
    parts.push(...management);
  }
  if (includeListAlternative) {
    if (parts.length > 0) parts.push('');
    parts.push(LIST_AS_ALTERNATIVE_LINE);
  }
  return parts.join('\n');
}

/** Viñeta de atajo con palabra clave en negrita. */
export function shortcutBullet(boldKey: string, rest = ''): string {
  const key = stripWhatsAppBoldMarkers(boldKey);
  const suffix = rest.trim();
  if (!key) return '';
  return suffix ? `• *${key}* ${suffix}` : `• *${key}*`;
}
