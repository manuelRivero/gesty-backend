/**
 * Escape tipable de gestión de pedido (Menú / Ver pedido / Nota / etc.).
 *
 * Corre antes del ReAct cuando hay shortlist de complementos u otra selección
 * pendiente: evita que "notas" o "pedido" se interpreten como add_cart_item.
 */

import type { EnrichedContext, HandlerResult } from '../controllers/webhook/types';
import {
  interactiveResponse,
  listResponse,
  textResponse,
} from '../controllers/webhook/utils';
import { prisma } from '../lib/prisma';
import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../repositories';
import { handleViewMenuFromWebhook } from './category.service';
import {
  handleShowCartForEditionFromWebhook,
  handleViewCartFromWebhook,
} from './cart.service';
import { formatBotUserMessage, normalizeMetadata } from './productQuery/utils';
import { wrapWhatsAppBold, stripWhatsAppBoldMarkers } from '../utils/whatsappBold';
import { CheckoutHandler } from '../controllers/webhook/handlers/checkoutHandler';
import type { ConversationMetadata } from './productQuery/types';

export type ManagementShortcutKind =
  | 'menu'
  | 'view_cart'
  | 'edit_cart'
  | 'checkout'
  | 'note';

/** Normaliza texto tipado (sin negritas WA, minúsculas, espacios colapsados). */
export function normalizeManagementShortcutText(raw: string): string {
  return stripWhatsAppBoldMarkers(raw)
    .replace(/^[•\-–—]\s*/, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function matchManagementShortcut(
  raw: string
): ManagementShortcutKind | null {
  const t = normalizeManagementShortcutText(raw);
  if (!t) return null;

  if (/^(ver\s+)?(el\s+)?menu$/.test(t)) return 'menu';
  if (/^(ver\s+)?(el\s+)?pedido$/.test(t) || t === 'ver mi pedido') {
    return 'view_cart';
  }
  if (/^modificar(\s+(el\s+)?pedido)?$/.test(t)) return 'edit_cart';
  if (
    /^(finalizar|cerrar)(\s+(el\s+)?pedido)?$/.test(t) ||
    t === 'checkout' ||
    t === 'pagar'
  ) {
    return 'checkout';
  }
  if (/^notas?(\s+del\s+pedido)?$/.test(t)) return 'note';

  return null;
}

const clearSelectionPending = async (conversationId: string): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [
    'pendingProductSelection',
    'pendingQuestion',
    'candidateProductIds',
  ]);
};

type CartLine = {
  productId: string;
  name: string;
  variation: string | null;
};

async function loadActiveCartLines(
  businessId: string,
  customerPhone: string
): Promise<CartLine[]> {
  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: businessId,
      customer_phone: customerPhone,
      status: 'active',
    },
    include: {
      draft_order_item: {
        include: { menu_item: { select: { name: true } } },
        orderBy: { id: 'asc' },
      },
    },
  });
  if (!draft) return [];
  return draft.draft_order_item
    .filter((it) => it.product_id)
    .map((it) => ({
      productId: it.product_id!,
      name: it.menu_item?.name ?? 'Producto',
      variation: it.variation ?? null,
    }));
}

async function beginNoteCapture(
  ctx: EnrichedContext,
  lines: CartLine[]
): Promise<HandlerResult> {
  const conversationId = ctx.conversation.id;

  if (lines.length === 0) {
    return textResponse(
      formatBotUserMessage(
        'Pedido vacío',
        '📝',
        'Todavía no hay platos en el carrito. Sumá algo del menú y después podés dejar una nota.'
      )
    );
  }

  if (lines.length === 1) {
    const only = lines[0]!;
    await patchConversationMetadata(conversationId, {
      awaitingItemNote: {
        productId: only.productId,
        productName: only.name,
        askedAt: new Date().toISOString(),
      },
    });
    const label = only.variation
      ? `${only.name} (${only.variation})`
      : only.name;
    return textResponse(
      formatBotUserMessage(
        'Nota del pedido',
        '📝',
        `¿Qué querés anotar para ${wrapWhatsAppBold(label)}?\n\nEscribí la instrucción en un mensaje (ej.: poca sal, sin cebolla, término medio).`
      )
    );
  }

  const opts = lines
    .map((l) => {
      const label = l.variation ? `${l.name} (${l.variation})` : l.name;
      return `• ${wrapWhatsAppBold(label)}`;
    })
    .join('\n');

  await patchConversationMetadata(conversationId, {
    awaitingItemNote: {
      productId: null,
      productName: null,
      candidates: lines.map((l) => ({
        productId: l.productId,
        productName: l.name,
      })),
      askedAt: new Date().toISOString(),
    },
  });

  return textResponse(
    formatBotUserMessage(
      'Nota del pedido',
      '📝',
      `¿Sobre cuál ítem es la nota?\n\n${opts}\n\nEscribí el nombre del plato (después te pido el detalle).`
    )
  );
}

function parseAwaitingItemNote(
  meta: ConversationMetadata
): {
  productId: string | null;
  productName: string | null;
  candidates?: Array<{ productId: string; productName: string }>;
} | null {
  const raw = meta.awaitingItemNote;
  if (!raw || typeof raw !== 'object') return null;
  const productId =
    typeof (raw as { productId?: unknown }).productId === 'string'
      ? (raw as { productId: string }).productId
      : null;
  const productName =
    typeof (raw as { productName?: unknown }).productName === 'string'
      ? (raw as { productName: string }).productName
      : null;
  const candidatesRaw = (raw as { candidates?: unknown }).candidates;
  const candidates = Array.isArray(candidatesRaw)
    ? candidatesRaw
        .filter(
          (c): c is { productId: string; productName: string } =>
            typeof c === 'object' &&
            c != null &&
            typeof (c as { productId?: unknown }).productId === 'string' &&
            typeof (c as { productName?: unknown }).productName === 'string'
        )
        .map((c) => ({
          productId: c.productId,
          productName: c.productName,
        }))
    : undefined;
  return { productId, productName, candidates };
}

async function applyItemNote(
  businessId: string,
  customerPhone: string,
  productId: string,
  note: string
): Promise<{ ok: true; itemName: string } | { ok: false; error: string }> {
  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: businessId,
      customer_phone: customerPhone,
      status: 'active',
    },
    include: {
      draft_order_item: {
        include: { menu_item: { select: { name: true } } },
      },
    },
  });
  if (!draft) return { ok: false, error: 'no_cart' };
  const line = draft.draft_order_item.find((it) => it.product_id === productId);
  if (!line) return { ok: false, error: 'not_in_cart' };
  await prisma.draft_order_item.update({
    where: { id: line.id },
    data: { notes: note.trim() || null },
  });
  return { ok: true, itemName: line.menu_item?.name ?? 'Producto' };
}

/**
 * Si hay captura de nota en curso, aplica el mensaje (o elige ítem).
 * Null si no aplica.
 */
export async function tryHandleAwaitingItemNoteHybrid(
  ctx: EnrichedContext
): Promise<HandlerResult | null> {
  const userMessage = ctx.message?.text?.body?.trim() ?? '';
  if (!userMessage) return null;

  const meta = normalizeMetadata(ctx.conversationState?.metadata);
  const awaiting = parseAwaitingItemNote(meta);
  if (!awaiting) return null;

  // Si el usuario pide otra acción de gestión, no consumir como nota.
  if (matchManagementShortcut(userMessage)) return null;

  const businessId = ctx.business?.id;
  const phone = ctx.customer?.phone_number ?? ctx.to;
  if (!businessId || !phone) return null;

  // Fase: eligió ítem entre varios
  if (!awaiting.productId && awaiting.candidates?.length) {
    const norm = normalizeManagementShortcutText(userMessage);
    const hit = awaiting.candidates.find((c) => {
      const name = normalizeManagementShortcutText(c.productName);
      return name === norm || name.includes(norm) || norm.includes(name);
    });
    if (!hit) {
      const opts = awaiting.candidates
        .map((c) => `• ${wrapWhatsAppBold(c.productName)}`)
        .join('\n');
      return textResponse(
        formatBotUserMessage(
          'Elegí el ítem',
          '📝',
          `No identifiqué el plato. Probá con uno de estos:\n\n${opts}`
        )
      );
    }
    await patchConversationMetadata(ctx.conversation.id, {
      awaitingItemNote: {
        productId: hit.productId,
        productName: hit.productName,
        askedAt: new Date().toISOString(),
      },
    });
    return textResponse(
      formatBotUserMessage(
        'Nota del pedido',
        '📝',
        `Perfecto, para ${wrapWhatsAppBold(hit.productName)}. ¿Qué querés anotar?`
      )
    );
  }

  if (!awaiting.productId) return null;

  const result = await applyItemNote(
    businessId,
    phone,
    awaiting.productId,
    userMessage
  );
  await omitConversationMetadataKeys(ctx.conversation.id, ['awaitingItemNote']);

  if (!result.ok) {
    return textResponse(
      formatBotUserMessage(
        'No pude anotar',
        '😔',
        'No encontré ese ítem en el carrito. Decime ver pedido y lo intentamos de nuevo.'
      )
    );
  }

  return textResponse(
    formatBotUserMessage(
      'Nota guardada',
      '📝',
      `Listo: ${wrapWhatsAppBold(result.itemName)} → _${userMessage.trim()}_.`
    )
  );
}

/**
 * Atajos tipables de gestión. Null si el mensaje no matchea.
 */
export async function tryHandleManagementShortcutHybrid(
  ctx: EnrichedContext
): Promise<HandlerResult | null> {
  const userMessage = ctx.message?.text?.body?.trim() ?? '';
  if (!userMessage) return null;

  const kind = matchManagementShortcut(userMessage);
  if (!kind) return null;

  const conversationId = ctx.conversation?.id;
  if (!conversationId) return null;

  await clearSelectionPending(conversationId);
  await omitConversationMetadataKeys(conversationId, ['awaitingItemNote']);

  try {
    if (kind === 'menu') {
      const result = await handleViewMenuFromWebhook(ctx.payload);
      if (result == null) return null;
      if (typeof result === 'string') return textResponse(result);
      return listResponse(result);
    }

    if (kind === 'view_cart') {
      const result = await handleViewCartFromWebhook(ctx.payload);
      if (result == null) return null;
      if (typeof result === 'string') return textResponse(result);
      return listResponse(result);
    }

    if (kind === 'edit_cart') {
      const result = await handleShowCartForEditionFromWebhook(ctx.payload);
      if (result == null) return null;
      if (typeof result === 'string') return textResponse(result);
      if (result.type === 'list') return listResponse(result);
      return interactiveResponse(result);
    }

    if (kind === 'checkout') {
      const handler = new CheckoutHandler();
      return handler.execute(ctx);
    }

    if (kind === 'note') {
      const businessId = ctx.business?.id;
      const phone = ctx.customer?.phone_number ?? ctx.to;
      if (!businessId || !phone) return null;
      const lines = await loadActiveCartLines(businessId, phone);
      return beginNoteCapture(ctx, lines);
    }
  } catch (err) {
    console.error('[managementShortcut] failed', err);
    return null;
  }

  return null;
}
