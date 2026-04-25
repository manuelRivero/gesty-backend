import type { WhatsAppInteractiveMessage } from '../domain/intent/whatsappTemplates';
import { parseAddItemButtonPayload } from '../controllers/webhook/utils';

/** WhatsApp Cloud API: reply button id máx. 256 caracteres; título máx. 20. */
export const MAX_WHATSAPP_BUTTON_ID_LENGTH = 256;
export const MAX_WHATSAPP_BUTTON_TITLE_LENGTH = 20;
export const MAX_WHATSAPP_REPLY_BUTTONS = 3;

function truncateTitle(title: string): string {
  const t = title.trim();
  if (t.length <= MAX_WHATSAPP_BUTTON_TITLE_LENGTH) return t;
  return t.slice(0, MAX_WHATSAPP_BUTTON_TITLE_LENGTH);
}

function sanitizeButtonId(rawId: string): string | null {
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id || id === 'undefined' || id === 'null') return null;
  if (id.length >= MAX_WHATSAPP_BUTTON_ID_LENGTH) return null;
  return id;
}

/**
 * Normaliza id ADD_ITEM a forma canónica ADD_ITEM:<productId>:<qty 1–99>.
 * Rechaza payloads con productId vacío o inválido.
 */
function normalizeAddItemButtonId(id: string): string | null {
  if (!id.startsWith('ADD_ITEM:')) return sanitizeButtonId(id);
  const parsed = parseAddItemButtonPayload(id);
  if (!parsed.productId || parsed.productId === 'undefined') return null;
  const qty = parsed.quantityFromPayload ?? 1;
  if (qty < 1 || qty > 99) return null;
  const canonical = `ADD_ITEM:${parsed.productId}:${qty}`;
  if (canonical.length >= MAX_WHATSAPP_BUTTON_ID_LENGTH) return null;
  return canonical;
}

function normalizeSingleReplyButton(
  btn: WhatsAppInteractiveMessage['interactive']['action']['buttons'][number]
): WhatsAppInteractiveMessage['interactive']['action']['buttons'][number] | null {
  if (btn?.type !== 'reply' || !btn.reply) return null;
  const rawId = btn.reply.id;
  const rawTitle = btn.reply.title;
  if (typeof rawId !== 'string' || typeof rawTitle !== 'string') return null;

  const idNorm = rawId.startsWith('ADD_ITEM:')
    ? normalizeAddItemButtonId(rawId)
    : sanitizeButtonId(rawId);
  if (!idNorm) return null;

  const titleNorm = truncateTitle(rawTitle);
  if (!titleNorm) return null;

  return {
    type: 'reply',
    reply: { id: idNorm, title: titleNorm },
  };
}

export function buildFallbackTextFromInteractive(
  interactive: WhatsAppInteractiveMessage['interactive']
): string {
  const parts: string[] = [];
  if (interactive.header?.type === 'text' && interactive.header.text?.trim()) {
    parts.push(interactive.header.text.trim());
  }
  if (interactive.body?.text?.trim()) {
    parts.push(interactive.body.text.trim());
  }
  if (interactive.footer?.text?.trim()) {
    parts.push(interactive.footer.text.trim());
  }
  return (
    parts.join('\n\n') ||
    'No pudimos mostrar los botones. Escribí tu pedido o elegí una opción del menú.'
  );
}

export type NormalizeButtonInteractiveResult =
  | { success: true; message: WhatsAppInteractiveMessage }
  | { success: false; fallbackText: string };

/**
 * Valida y normaliza mensajes interactive.type === "button" para la API de WhatsApp.
 * - Máx. 3 botones; ids únicos; títulos ≤ 20; ids &lt; 256; ADD_ITEM canónico.
 */
export function normalizeWhatsAppButtonInteractiveMessage(
  message: WhatsAppInteractiveMessage
): NormalizeButtonInteractiveResult {
  const rawButtons = message.interactive?.action?.buttons ?? [];
  const seen = new Set<string>();
  const out: WhatsAppInteractiveMessage['interactive']['action']['buttons'] = [];

  for (const b of rawButtons) {
    const normalized = normalizeSingleReplyButton(b);
    if (!normalized) continue;
    if (seen.has(normalized.reply.id)) continue;
    seen.add(normalized.reply.id);
    out.push(normalized);
    if (out.length >= MAX_WHATSAPP_REPLY_BUTTONS) break;
  }

  if (out.length === 0) {
    return {
      success: false,
      fallbackText: buildFallbackTextFromInteractive(message.interactive),
    };
  }

  return {
    success: true,
    message: {
      ...message,
      interactive: {
        ...message.interactive,
        action: {
          ...message.interactive.action,
          buttons: out,
        },
      },
    },
  };
}
