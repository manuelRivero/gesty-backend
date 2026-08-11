/**
 * pendingVariation — espera estructurada de variación en texto libre (híbrido).
 *
 * Tras `add_cart_item` → variation_required / invalid, persistimos el productId
 * y la lista canónica. El siguiente turno puede resolver sin LLM si el mensaje
 * matchea una variación (D6: matchVariation).
 */

import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../repositories';
import { normalizeMetadata } from './productQuery/utils';
import type { ConversationMetadata } from './productQuery/types';
import { matchVariation } from './menu/menuItemVariations';
import { buildAddItemMessage } from './cart.service';
import { prisma } from '../lib/prisma';
import type { EnrichedContext, HandlerResult } from '../controllers/webhook/types';
import { formatBotUserMessage } from './productQuery/utils';

export const PENDING_VARIATION_KEY = 'pendingVariation' as const;

export type PendingVariation = {
  productId: string;
  productName: string;
  variations: string[];
  quantity: number;
  askedAt: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

export const parsePendingVariation = (raw: unknown): PendingVariation | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.productId !== 'string' || !raw.productId.trim()) return null;
  if (typeof raw.productName !== 'string' || !raw.productName.trim()) return null;
  if (!Array.isArray(raw.variations) || raw.variations.length === 0) return null;
  const variations = raw.variations
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
  if (variations.length === 0) return null;
  const quantity =
    typeof raw.quantity === 'number' && raw.quantity >= 1
      ? Math.min(99, Math.floor(raw.quantity))
      : 1;
  const askedAt =
    typeof raw.askedAt === 'string' && raw.askedAt
      ? raw.askedAt
      : new Date().toISOString();
  return {
    productId: raw.productId.trim(),
    productName: raw.productName.trim(),
    variations,
    quantity,
    askedAt,
  };
};

export const getPendingVariation = (metadata: unknown): PendingVariation | null => {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  return parsePendingVariation(meta.pendingVariation);
};

export const setPendingVariation = async (params: {
  conversationId: string;
  productId: string;
  productName: string;
  variations: string[];
  quantity?: number;
}): Promise<void> => {
  const variations = params.variations
    .filter((v) => typeof v === 'string' && v.trim())
    .map((v) => v.trim());
  if (variations.length === 0) return;

  await patchConversationMetadata(params.conversationId, {
    pendingVariation: {
      productId: params.productId,
      productName: params.productName.trim(),
      variations,
      quantity: Math.min(99, Math.max(1, Math.floor(params.quantity ?? 1))),
      askedAt: new Date().toISOString(),
    } satisfies PendingVariation,
  });
};

export const clearPendingVariation = async (
  conversationId: string
): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [PENDING_VARIATION_KEY]);
};

const escapeRegExp = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Quita la variación matcheada del mensaje y deja el resto como posible nota
 * ("Muy picante Pero que no tenga tanta cebolla" → "que no tenga tanta cebolla").
 */
export const extractNoteAfterVariation = (
  userMessage: string,
  matchedVariation: string
): string | null => {
  const re = new RegExp(escapeRegExp(matchedVariation), 'i');
  let rest = userMessage.replace(re, ' ').replace(/\s+/g, ' ').trim();
  rest = rest
    .replace(/^(pero|y|que|,|;|:|\.|!|\?|\-–—)+/i, '')
    .replace(/(pero|y|,|;|\.|!|\?|\-–—)+$/i, '')
    .trim();
  if (rest.length < 3) return null;
  if (/^(dale|ok|okay|si|sí|listo|va|claro|bueno|perfecto|bárbaro)$/i.test(rest)) {
    return null;
  }
  return rest;
};

export type ResolvePendingVariationResult =
  | {
      status: 'matched';
      productId: string;
      productName: string;
      variation: string;
      quantity: number;
      note: string | null;
    }
  | { status: 'ambiguous'; candidates: string[]; pending: PendingVariation }
  | { status: 'none' };

/** Intenta resolver el mensaje del usuario contra pendingVariation. */
export const resolvePendingVariationFromMessage = (
  metadata: unknown,
  userMessage: string
): ResolvePendingVariationResult => {
  const pending = getPendingVariation(metadata);
  if (!pending) return { status: 'none' };

  const text = userMessage.trim();
  if (!text) return { status: 'none' };

  const match = matchVariation(text, pending.variations);
  if (match.status === 'ok') {
    return {
      status: 'matched',
      productId: pending.productId,
      productName: pending.productName,
      variation: match.value,
      quantity: pending.quantity,
      note: extractNoteAfterVariation(text, match.value),
    };
  }
  if (match.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      candidates: match.candidates,
      pending,
    };
  }
  return { status: 'none' };
};

export const buildPendingVariationContextLines = (
  metadata: unknown
): string[] => {
  const pending = getPendingVariation(metadata);
  if (!pending) return [];
  const opts = pending.variations.map((v) => `*${v}*`).join(', ');
  return [
    `- Variación pendiente: el cliente debe elegir una opción para *${pending.productName}* ` +
      `(productId: ${pending.productId}). Opciones del catálogo: ${opts}. ` +
      `Si el mensaje actual elige una (aunque traiga nota extra tipo "sin cebolla"), ` +
      `llamá add_cart_item(productId, quantity: ${pending.quantity}, variation=<opción exacta>). ` +
      `Si además hay preferencia de preparación, después update_item_note. ` +
      `NO relistes otros productos ni ignores la variación.`,
  ];
};

/**
 * Si hay variación pendiente y el mensaje del usuario matchea, suma al carrito
 * (y nota residual) sin pasar por el ReAct. Null si no aplica.
 */
export const tryHandlePendingVariationHybrid = async (
  ctx: EnrichedContext
): Promise<HandlerResult | null> => {
  const userMessage = ctx.message?.text?.body?.trim() ?? '';
  if (!userMessage) return null;

  const metadata = ctx.conversationState?.metadata;
  const resolved = resolvePendingVariationFromMessage(metadata, userMessage);
  if (resolved.status === 'none') return null;

  if (resolved.status === 'ambiguous') {
    const opts = resolved.candidates.map((c) => `*${c}*`).join(' o ');
    const text = formatBotUserMessage(
      'Elegí la variedad',
      '🌶️',
      `Para *${resolved.pending.productName}* necesito que elijas con más precisión: ${opts}.`
    );
    return { content: text, isInteractive: false, skipBodyHumanization: true };
  }

  const business = ctx.business;
  const conversation = ctx.conversation;
  const customer = ctx.customer;
  if (!business?.id || !conversation?.id || !customer?.phone_number) {
    return null;
  }

  try {
    const addResult = await buildAddItemMessage(
      business,
      conversation,
      resolved.productId,
      customer,
      resolved.quantity,
      'add',
      resolved.variation
    );

    await clearPendingVariation(conversation.id);

    if (resolved.note) {
      try {
        const draft = await prisma.draft_order.findFirst({
          where: {
            business_id: business.id,
            customer_phone: customer.phone_number,
            status: 'active',
          },
          select: { id: true },
        });
        if (draft) {
          await prisma.draft_order_item.updateMany({
            where: {
              draft_order_id: draft.id,
              product_id: resolved.productId,
              variation: resolved.variation,
            },
            data: { notes: resolved.note },
          });
        }
      } catch (err) {
        console.error('[pendingVariation] failed to attach residual note', err);
      }
    }

    const noteSuffix = resolved.note
      ? `\n\nAnoté: _${resolved.note}_.`
      : '';

    if (typeof addResult === 'string') {
      return {
        content: `${addResult}${noteSuffix}`,
        isInteractive: false,
        skipBodyHumanization: true,
      };
    }

    if (addResult.complementOnly) {
      return {
        content: addResult.mainFollowUpList,
        isInteractive: true,
        skipBodyHumanization: true,
      };
    }

    const mainWithNote = `${addResult.main}${noteSuffix}`;
    return {
      content: mainWithNote,
      isInteractive: false,
      skipBodyHumanization: true,
      followUps: [{ type: 'list', listMessage: addResult.mainFollowUpList }],
    };
  } catch (err) {
    console.error('[pendingVariation] tryHandlePendingVariationHybrid failed', err);
    return null;
  }
};
