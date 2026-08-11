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
const MAX_ROW_DESCRIPTION = 72;

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

export type SelectListCandidateMeta = {
  servesPeople?: number | null;
  priceAmount?: number | string | null;
};

/**
 * Meta tipable bajo el atajo: "sirve 2 · $11.000".
 * El nombre en negrita queda aparte para reconocimiento por texto.
 */
export const formatSelectListCandidateMeta = (
  params: SelectListCandidateMeta
): string | undefined => {
  const parts: string[] = [];
  const serves = params.servesPeople;
  if (typeof serves === 'number' && Number.isFinite(serves) && serves > 0) {
    parts.push(serves === 1 ? 'sirve 1' : `sirve ${Math.floor(serves)}`);
  }
  if (params.priceAmount != null && params.priceAmount !== '') {
    const n = Number(params.priceAmount);
    if (Number.isFinite(n)) {
      parts.push(`$${n.toLocaleString('es-AR')}`);
    }
  }
  return parts.length > 0 ? parts.join(' · ') : undefined;
};

/**
 * Si el modelo listó platos en prosa, nos quedamos con la intro hasta la
 * primera viñeta/numeración (el builder aporta los atajos con meta).
 */
export const sanitizeSelectFromListIntro = (raw: string): string => {
  const lines = raw
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const kept: string[] = [];
  for (const line of lines) {
    if (/^(\d+[\).\:]|[-•*])\s/.test(line)) break;
    if (/^\*\*[^*]+\*\*/.test(line) && kept.length > 0) break;
    // Línea que es casi solo un producto en negrita WA (*Nombre*)
    if (/^\*[^*]+\*\s*(\([^)]*\))?$/.test(line) && kept.length > 0) break;
    kept.push(line);
    if (kept.join(' ').length > 320) break;
  }
  const out = kept.join('\n').trim();
  return out || 'Decime cuál te gusta y lo sumamos.';
};

export type SelectListBodyCandidate = {
  title: string;
  /** Porciones / precio u otra meta corta (va después del nombre en negrita). */
  description?: string;
};

/**
 * Intro del agente + opciones en negrita (atajos tipables).
 * description se muestra como sufijo tipable: • *Nombre* — sirve 2 · $11.000
 * La lista WA se ofrece vía footer; no se agrega «O elegí de la lista.» al body.
 */
export const buildSelectFromListBodyText = (
  intro: string,
  candidates: SelectListBodyCandidate[],
  maxItems = 5
): string => {
  const bullets = candidates
    .slice(0, maxItems)
    .map((c) => {
      const name = c.title.trim();
      if (!name) return '';
      const meta = c.description?.trim();
      return meta ? shortcutBullet(name, `— ${meta}`) : shortcutBullet(name);
    })
    .filter(Boolean);

  return buildShortcutsThenListBody(sanitizeSelectFromListIntro(intro), bullets);
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
          ? c.description.slice(0, MAX_ROW_DESCRIPTION)
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

/** Payload del botón primario (metadata / cta_clicked). */
export const extractPrimaryPayload = (plan: CtaPlan): string | null => {
  const { primary } = plan;
  if (primary.kind === 'ADD_ITEM') {
    return `ADD_ITEM:${primary.productId}:${primary.quantity}`;
  }
  if (primary.kind === 'VIEW_MENU') return 'VIEW_MENU';
  if (primary.kind === 'VIEW_FEATURED') return 'FEATURED_PAGE:1';
  return null;
};

/** productId del plan primario si es ADD_ITEM. */
export const extractPrimaryProductId = (plan: CtaPlan): string | null => {
  if (plan.primary.kind === 'ADD_ITEM') return plan.primary.productId;
  return null;
};
