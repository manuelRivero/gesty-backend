/**
 * Builder de mensajes interactivos WhatsApp para el CTA híbrido.
 *
 * - ADD_ITEM / VIEW_MENU / VIEW_FEATURED → `WhatsAppInteractiveMessage` (botones reply, max 3)
 * - SELECT_FROM_LIST → `WhatsAppListMessage` via buildListMessageFromButtons
 *
 * Restricciones WhatsApp:
 *  - Máximo 3 botones reply por mensaje interactivo.
 *  - Título de botón: max 20 caracteres.
 *  - Payload (button id): max 256 caracteres.
 */

import type { HandlerResult } from '../controllers/webhook/types';
import { buildListMessageFromButtons, truncateTitle } from './index';
import { buildShortcutsThenListBody, shortcutBullet } from './listShortcutsBody';
import type { CtaPlan } from '../agents/types';

const MAX_BUTTON_TITLE = 20;
const MAX_PAYLOAD_LENGTH = 255;

const safeTitle = (label: string): string =>
  label.slice(0, MAX_BUTTON_TITLE);

const safePayload = (payload: string): string =>
  payload.slice(0, MAX_PAYLOAD_LENGTH);

const buildButtonReply = (id: string, title: string) => ({
  type: 'reply' as const,
  reply: {
    id: safePayload(id),
    title: safeTitle(title),
  },
});

/** Convierte un CtaAction simple (VIEW_MENU/VIEW_FEATURED) en payload string. */
const simpleActionToPayload = (action: { kind: 'VIEW_MENU' | 'VIEW_FEATURED' }): string => {
  if (action.kind === 'VIEW_MENU') return 'VIEW_MENU';
  return 'FEATURED_PAGE:1';
};

/**
 * Intro del agente + opciones en negrita (atajos) + alternativa lista WA.
 */
export const buildSelectFromListBodyText = (
  intro: string,
  candidates: Array<{ title: string }>,
  maxItems = 5
): string => {
  const bullets = candidates
    .slice(0, maxItems)
    .map((c) => c.title.trim())
    .filter(Boolean)
    .map((name) => shortcutBullet(name));

  return buildShortcutsThenListBody(intro, bullets);
};

/**
 * Construye un HandlerResult interactivo (botones o lista) a partir de un CtaPlan resuelto.
 * Nunca lanza: si algo falla devuelve `null` y el caller usa el texto plano.
 */
export const buildHybridCtaInteractive = (
  botResponseText: string,
  plan: CtaPlan
): HandlerResult | null => {
  try {
    const { primary, secondary } = plan;

    // SELECT_FROM_LIST → lista interactiva
    if (primary.kind === 'SELECT_FROM_LIST') {
      const listCandidates = primary.candidates.slice(0, 5);
      const rows = listCandidates.map((c) => ({
        title: truncateTitle(c.title, MAX_BUTTON_TITLE),
        payload: safePayload(`SELECT_PRODUCT:${c.productId}`),
        description: c.description
          ? c.description.slice(0, 60)
          : 'Seleccioná este producto',
        sectionTitle: 'Opciones disponibles',
      }));

      // Escape row
      rows.push({
        title: 'Ver menú completo',
        payload: 'VIEW_MENU',
        description: 'Explorar todas las categorías',
        sectionTitle: 'Navegación',
      });

      const intro = (primary.bodyText || botResponseText).trim();
      const bodyText = buildSelectFromListBodyText(intro, listCandidates);

      const listMsg = buildListMessageFromButtons(
        bodyText,
        rows,
        'Ver opciones',
        '',
        'Elegí o escribí'
      );

      return { content: listMsg, isInteractive: true };
    }

    // Botones reply (1-3 botones)
    const buttons: ReturnType<typeof buildButtonReply>[] = [];

    if (primary.kind === 'ADD_ITEM') {
      const payload = `ADD_ITEM:${primary.productId}:${primary.quantity}`;
      buttons.push(buildButtonReply(payload, primary.label));
    } else {
      // VIEW_MENU or VIEW_FEATURED
      const payload = simpleActionToPayload(primary as { kind: 'VIEW_MENU' | 'VIEW_FEATURED' });
      buttons.push(buildButtonReply(payload, primary.label));
    }

    // Botón secundario (escape obligatorio cuando primary es ADD_ITEM)
    if (secondary && buttons.length < 3) {
      const secPayload = simpleActionToPayload(secondary);
      buttons.push(buildButtonReply(secPayload, secondary.label));
    } else if (primary.kind === 'ADD_ITEM' && !secondary && buttons.length < 3) {
      // Garantizar escape si el planner olvidó ponerlo
      buttons.push(buildButtonReply('FEATURED_PAGE:1', 'Ver destacados'));
    }

    const interactiveMsg = {
      type: 'interactive' as const,
      interactive: {
        type: 'button' as const,
        header: { type: 'text' as const, text: '' },
        body: { text: botResponseText },
        footer: { text: 'Elegí una opción 👇' },
        action: { buttons },
      },
    };

    return { content: interactiveMsg, isInteractive: true };
  } catch (err) {
    console.error('[hybrid-cta] buildHybridCtaInteractive failed:', err);
    return null;
  }
};

/**
 * Extrae el payload del botón primario de un CtaPlan para guardar en metadata
 * (usado para correlacionar cta_clicked).
 */
export const extractPrimaryPayload = (plan: CtaPlan): string | null => {
  const { primary } = plan;
  if (primary.kind === 'ADD_ITEM') return `ADD_ITEM:${primary.productId}:${primary.quantity}`;
  if (primary.kind === 'VIEW_MENU') return 'VIEW_MENU';
  if (primary.kind === 'VIEW_FEATURED') return 'FEATURED_PAGE:1';
  return null;
};

/**
 * Extrae el productId del plan primario si es ADD_ITEM.
 */
export const extractPrimaryProductId = (plan: CtaPlan): string | null => {
  const { primary } = plan;
  if (primary.kind === 'ADD_ITEM') return primary.productId;
  return null;
};
