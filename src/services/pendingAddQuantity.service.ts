/**
 * pendingAddQuantity — ledger de “cantidad a confirmar” antes de escribir el carrito.
 *
 * Patrón alineado a tipables (pendingTipables): NO es un router regex.
 * El híbrido lee el ledger en [ESTADO DEL CLIENTE] y confirma con
 * add_cart_item(productId, quantity=N). La garantía de no escribir sin
 * confirmación vive en la tool / AddItemHandler (gate duro), no en matchers.
 */

import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../repositories';
import { normalizeMetadata, getRequestedPartySize } from './productQuery/utils';
import type { ConversationMetadata } from './productQuery/types';
import { formatBotUserMessage } from './productQuery/utils';
import {
  needsAddQuantityConfirmation,
  suggestAddQuantity,
} from './addQuantitySuggestion';

export const PENDING_ADD_QUANTITY_KEY = 'pendingAddQuantity' as const;

export type PendingAddQuantitySource = 'deterministic' | 'hybrid' | 'complement';

export type PendingAddQuantity = {
  productId: string;
  productName: string;
  suggestedQuantity: number;
  servesPeople: number | null;
  partySize: number | null;
  variation?: string | null;
  source: PendingAddQuantitySource;
  askedAt: string;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null;

export const parsePendingAddQuantity = (raw: unknown): PendingAddQuantity | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.productId !== 'string' || !raw.productId.trim()) return null;
  if (typeof raw.productName !== 'string' || !raw.productName.trim()) return null;
  const suggested =
    typeof raw.suggestedQuantity === 'number' && raw.suggestedQuantity >= 1
      ? Math.min(99, Math.floor(raw.suggestedQuantity))
      : null;
  if (suggested == null) return null;
  const servesPeople =
    typeof raw.servesPeople === 'number' && raw.servesPeople > 0
      ? Math.floor(raw.servesPeople)
      : null;
  const partySize =
    typeof raw.partySize === 'number' && raw.partySize >= 1
      ? Math.min(99, Math.floor(raw.partySize))
      : null;
  const source =
    raw.source === 'deterministic' ||
    raw.source === 'hybrid' ||
    raw.source === 'complement'
      ? raw.source
      : 'deterministic';
  const variation =
    typeof raw.variation === 'string' && raw.variation.trim()
      ? raw.variation.trim()
      : raw.variation === null
        ? null
        : undefined;
  const askedAt =
    typeof raw.askedAt === 'string' && raw.askedAt
      ? raw.askedAt
      : new Date().toISOString();
  return {
    productId: raw.productId.trim(),
    productName: raw.productName.trim(),
    suggestedQuantity: suggested,
    servesPeople,
    partySize,
    ...(variation !== undefined ? { variation } : {}),
    source,
    askedAt,
  };
};

export const getPendingAddQuantity = (
  metadata: unknown
): PendingAddQuantity | null => {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  return parsePendingAddQuantity(meta.pendingAddQuantity);
};

/**
 * Con cantidad pendiente, el turno debe ir al híbrido aunque NLP diga un
 * intent cerrado (p. ej. MODIFY_QUANTITY ante «quiero tres»). Es ruteo de
 * ledger, no interpretación del mensaje (norma tipables).
 */
export const shouldForceHybridForPendingAddQuantity = (
  metadata: unknown
): boolean => getPendingAddQuantity(metadata) != null;

export const setPendingAddQuantity = async (params: {
  conversationId: string;
  productId: string;
  productName: string;
  suggestedQuantity: number;
  servesPeople?: number | null;
  partySize?: number | null;
  variation?: string | null;
  source?: PendingAddQuantitySource;
}): Promise<PendingAddQuantity> => {
  const pending: PendingAddQuantity = {
    productId: params.productId.trim(),
    productName: params.productName.trim(),
    suggestedQuantity: Math.min(
      99,
      Math.max(1, Math.floor(params.suggestedQuantity))
    ),
    servesPeople:
      params.servesPeople != null && params.servesPeople > 0
        ? Math.floor(params.servesPeople)
        : null,
    partySize:
      params.partySize != null && params.partySize >= 1
        ? Math.min(99, Math.floor(params.partySize))
        : null,
    variation:
      typeof params.variation === 'string' && params.variation.trim()
        ? params.variation.trim()
        : params.variation === null
          ? null
          : undefined,
    source: params.source ?? 'deterministic',
    askedAt: new Date().toISOString(),
  };
  await patchConversationMetadata(params.conversationId, {
    pendingAddQuantity: pending,
  });
  return pending;
};

export const clearPendingAddQuantity = async (
  conversationId: string
): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [PENDING_ADD_QUANTITY_KEY]);
};

export function buildPendingAddQuantityMessage(pending: PendingAddQuantity): string {
  const name = pending.productName;
  const sug = pending.suggestedQuantity;
  const party = pending.partySize;
  const serves = pending.servesPeople;
  const unitsLabel = sug === 1 ? '1 unidad' : `${sug} unidades`;

  let why: string;
  if (party != null && serves != null && serves > 0) {
    const portionHint =
      serves === 1
        ? 'Cada unidad es para 1 persona. '
        : `Cada unidad alcanza para ${serves} personas. `;
    why =
      `${portionHint}Como el pedido es para ${party} persona${party === 1 ? '' : 's'} ` +
      `te sugiero ${unitsLabel}, pero podés pedir las que gustes.`;
  } else if (party != null && party >= 1) {
    why =
      `Como el pedido es para ${party} persona${party === 1 ? '' : 's'} ` +
      `te sugiero ${unitsLabel}, pero podés pedir las que gustes.`;
  } else {
    why = `Te sugiero ${unitsLabel}, pero podés pedir las que gustes.`;
  }

  const inner =
    `¿Cuántas unidades de *${name}* querés sumar?\n\n` + why;

  return formatBotUserMessage('¿Cuántas querés sumar?', '🔢', inner);
}

/** Ledger para el híbrido (misma filosofía que tipables de gestión). */
export const buildPendingAddQuantityContextLines = (
  metadata: unknown
): string[] => {
  const pending = getPendingAddQuantity(metadata);
  if (!pending) return [];
  return [
    `- Cantidad pendiente de confirmar (tipable; el cliente puede responder en prosa): ` +
      `*${pending.productName}* (productId: ${pending.productId}), sugerido ${pending.suggestedQuantity}×` +
      (pending.variation ? `, variación *${pending.variation}*` : '') +
      `. Interpretá el mensaje (número, "dale"/"la sugerida" → ${pending.suggestedQuantity}, ` +
      `"solo una", "las tres", etc.) y llamá add_cart_item(productId, quantity=<n>` +
      (pending.variation ? `, variation="${pending.variation}"` : '') +
      `). Si cancela ("cancelar", "no", "mejor no"): clear_pending_add_quantity() y confirmá en texto breve. ` +
      `NO asumas la sugerencia sin confirmación. NO ofrezcas complementos hasta un add exitoso.`,
  ];
};

/**
 * Arma el pending si D3 aplica. Null si no hace falta confirmación.
 */
export async function maybeSetPendingAddQuantity(params: {
  conversationId: string;
  productId: string;
  productName: string;
  servesPeople: number | null | undefined;
  metadata: unknown;
  variation?: string | null;
  source: PendingAddQuantitySource;
}): Promise<PendingAddQuantity | null> {
  const partySize = getRequestedPartySize(
    normalizeMetadata(params.metadata) as ConversationMetadata
  );
  const { suggestedQuantity } = suggestAddQuantity({
    partySize,
    servesPeople: params.servesPeople,
  });
  if (
    !needsAddQuantityConfirmation({
      suggestedQuantity,
      partySize,
    })
  ) {
    return null;
  }
  return setPendingAddQuantity({
    conversationId: params.conversationId,
    productId: params.productId,
    productName: params.productName,
    suggestedQuantity,
    servesPeople: params.servesPeople ?? null,
    partySize,
    variation: params.variation,
    source: params.source,
  });
}
