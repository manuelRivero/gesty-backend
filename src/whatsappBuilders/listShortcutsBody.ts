/**
 * Formato común para mensajes con lista interactiva + atajos en texto:
 * 1) intro / atajos en negrita (primero)
 * 2) alternativa: elegir de la lista WA
 */

import { stripWhatsAppBoldMarkers } from '../utils/whatsappBold';

export const LIST_AS_ALTERNATIVE_LINE = 'O elegí de la lista.';

export const MANAGEMENT_CONTINUE_LINE =
  'O podés continuar con la gestión de tu pedido.';

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

/**
 * Body post-add / complemento: sugerencias de platos, luego gestión, luego lista WA.
 * Evita mezclar upselles y acciones (Menú / Finalizar) en un solo bloque de viñetas.
 */
export function buildSuggestionsThenManagementThenListBody(params: {
  intro: string;
  suggestionBullets: string[];
  managementBullets: string[];
  managementIntro?: string;
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
  if (parts.length > 0) parts.push('');
  parts.push(LIST_AS_ALTERNATIVE_LINE);
  return parts.join('\n');
}

/** Viñeta de atajo con palabra clave en negrita. */
export function shortcutBullet(boldKey: string, rest = ''): string {
  const key = stripWhatsAppBoldMarkers(boldKey);
  const suffix = rest.trim();
  if (!key) return '';
  return suffix ? `• *${key}* ${suffix}` : `• *${key}*`;
}
