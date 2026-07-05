/**
 * Oferta conversacional activa (agent-first).
 *
 * Cuando el bot ofrece sumar un producto (CTA, product focus, etc.), persistimos
 * `lastOffer` en metadata para que el hybrid ReAct resuelva confirmaciones en
 * texto libre ("agrega uno", "dale") vía add_cart_item, sin gates determinísticos.
 */

import {
  patchConversationMetadata,
  omitConversationMetadataKeys,
  setLastReferencedProductId,
} from '../repositories';
import type { ConversationMetadata } from './productQuery/types';
import { normalizeMetadata } from './productQuery/utils';

export type LastOfferKind = 'ADD_ITEM';

export type LastOfferSource =
  | 'hybrid_cta'
  | 'product_query'
  | 'product_focus'
  | 'product_attribute';

export interface LastOffer {
  kind: LastOfferKind;
  productId: string;
  productName: string;
  suggestedQuantity: number;
  offeredAt: string;
  source: LastOfferSource;
}

export type LastOfferNlpHint = {
  intent: string;
  detectedProductName: string | null;
  quantity: number | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const parseLastOffer = (raw: unknown): LastOffer | null => {
  if (!isRecord(raw)) return null;
  if (raw.kind !== 'ADD_ITEM') return null;
  if (typeof raw.productId !== 'string' || !raw.productId.trim()) return null;
  if (typeof raw.productName !== 'string' || !raw.productName.trim()) return null;
  const qty =
    typeof raw.suggestedQuantity === 'number' && raw.suggestedQuantity >= 1
      ? Math.min(99, Math.floor(raw.suggestedQuantity))
      : 1;
  if (typeof raw.offeredAt !== 'string' || !raw.offeredAt) return null;
  const source = raw.source;
  if (
    source !== 'hybrid_cta' &&
    source !== 'product_query' &&
    source !== 'product_focus' &&
    source !== 'product_attribute'
  ) {
    return null;
  }
  return {
    kind: 'ADD_ITEM',
    productId: raw.productId.trim(),
    productName: raw.productName.trim(),
    suggestedQuantity: qty,
    offeredAt: raw.offeredAt,
    source,
  };
};

export const getLastOffer = (metadata: unknown): LastOffer | null => {
  const meta = normalizeMetadata(metadata);
  return parseLastOffer(meta.lastOffer);
};

export const persistLastOffer = async (params: {
  conversationId: string;
  productId: string;
  productName: string;
  suggestedQuantity?: number;
  source: LastOfferSource;
}): Promise<void> => {
  const suggestedQuantity = Math.min(
    99,
    Math.max(1, Math.floor(params.suggestedQuantity ?? 1))
  );
  const lastOffer: LastOffer = {
    kind: 'ADD_ITEM',
    productId: params.productId,
    productName: params.productName.trim(),
    suggestedQuantity,
    offeredAt: new Date().toISOString(),
    source: params.source,
  };

  await patchConversationMetadata(params.conversationId, {
    lastOffer,
    lastReferencedProductName: lastOffer.productName,
  });
  await setLastReferencedProductId(params.conversationId, params.productId);
};

export const clearLastOffer = async (conversationId: string): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, ['lastOffer']);
};

/** Líneas para inyectar en [ESTADO DEL CLIENTE] del hybrid agent. */
export const buildLastOfferContextLines = (
  metadata: unknown,
  nlpHint?: LastOfferNlpHint | null
): string[] => {
  const lines: string[] = [];
  const offer = getLastOffer(metadata);

  if (offer) {
    lines.push(
      `- Oferta activa: sumar ${offer.suggestedQuantity}× *${offer.productName}* ` +
        `(productId: ${offer.productId}). Origen: ${offer.source}.`
    );
    lines.push(
      '- Si el mensaje del cliente expresa acuerdo, aprobación o intención de proceder con esta oferta ' +
        '— aunque sea de forma indirecta, breve o coloquial — usá add_cart_item con ESE productId y ' +
        'la cantidad que indique (si no especifica, usá la sugerida arriba). ' +
        'Ejemplos NO exhaustivos: "sí", "dale", "perfecto", "ok", "listo", "va", "claro", "bueno", ' +
        '"lo quiero", "ponelo", "sumame uno", "agrega", "bárbaro", "genial", "re bien", "eso". ' +
        'Principio: si hay duda razonable de que el cliente está confirmando la oferta, confirmá y agregá. ' +
        'No preguntes de nuevo qué quiere agregar si ya hay una oferta activa y el mensaje es afirmativo.'
    );
  }

  if (nlpHint) {
    lines.push(
      `- Hint NLP (secundario, no vinculante): intent=${nlpHint.intent}, ` +
        `producto=${nlpHint.detectedProductName ?? 'ninguno'}, ` +
        `cantidad=${nlpHint.quantity ?? 'ninguna'}`
    );
  }

  return lines;
};
