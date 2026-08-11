/**
 * pendingVariation — ledger de “variedad a confirmar” antes de escribir el carrito.
 *
 * Patrón tipables / pendingAddQuantity: NO es un router regex pre-ReAct.
 * El híbrido lee el ledger en [ESTADO DEL CLIENTE] y confirma con
 * add_cart_item(..., variation=<opción>). La tool valida la opción contra
 * el catálogo (matchVariation) — eso es gate de datos, no interpretación
 * del mensaje del usuario fuera del agente.
 */

import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../repositories';
import type { ConversationMetadata } from './productQuery/types';
import { normalizeMetadata } from './productQuery/utils';

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

/** Ledger para el híbrido (misma filosofía que tipables / pendingAddQuantity). */
export const buildPendingVariationContextLines = (
  metadata: unknown
): string[] => {
  const pending = getPendingVariation(metadata);
  if (!pending) return [];
  const opts = pending.variations.map((v) => `*${v}*`).join(', ');
  return [
    `- Variación pendiente de confirmar (tipable; el cliente puede responder en prosa): ` +
      `*${pending.productName}* (productId: ${pending.productId}). Opciones del catálogo: ${opts}. ` +
      `Interpretá el mensaje (nombre parcial, typo razonable, nota extra tipo "sin cebolla") y llamá ` +
      `add_cart_item(productId, quantity: ${pending.quantity}, variation=<opción del catálogo>). ` +
      `Si además hay preferencia de preparación, después update_item_note. ` +
      `Si cancela: clear_pending_variation() y confirmá breve. ` +
      `NO relistes otros productos ni ignores la variación. NO asumas una opción sin que el cliente elija.`,
  ];
};
