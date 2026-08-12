/**
 * CONFIRMAR_OFERTA — Opportunity (TAXONOMIA §3 / Fase B.2).
 *
 * Cuando el bot ofrece sumar un producto, se persiste en el Ledger
 * (`intentLedger.CONFIRMAR_OFERTA`), no en un bag paralelo. El TTL del
 * catálogo decide permiso en `rankActiveIntent` (V-12 corregida).
 * Presupuesto 1 (ADR-0008 / D7).
 */

import {
  omitConversationMetadataKeys,
  setLastReferencedProductId,
} from '../repositories';
import { getIntentCatalogEntry } from '../domain/intent/family';
import type { IntentCandidate } from '../domain/intent/family';
import type { ConversationMetadata } from './productQuery/types';
import { normalizeMetadata } from './productQuery/utils';
import { patchIntentLedgerEntry } from './intentLedger.repository';
import { computeCatalogPermission } from './intent/activeIntent.service';

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isValidSource = (source: unknown): source is LastOfferSource =>
  source === 'hybrid_cta' ||
  source === 'product_query' ||
  source === 'product_focus' ||
  source === 'product_attribute';

/** Lee la oferta desde el Ledger; fallback legacy a `metadata.lastOffer` (migración). */
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
  if (!isValidSource(raw.source)) return null;
  return {
    kind: 'ADD_ITEM',
    productId: raw.productId.trim(),
    productName: raw.productName.trim(),
    suggestedQuantity: qty,
    offeredAt: raw.offeredAt,
    source: raw.source,
  };
};

export const getLastOffer = (metadata: unknown): LastOffer | null => {
  const meta = normalizeMetadata(metadata);
  const ledgerEntry = meta.intentLedger?.CONFIRMAR_OFERTA;
  if (
    ledgerEntry &&
    typeof ledgerEntry.productId === 'string' &&
    typeof ledgerEntry.productName === 'string'
  ) {
    const fromLedger = parseLastOffer({
      kind: 'ADD_ITEM',
      productId: ledgerEntry.productId,
      productName: ledgerEntry.productName,
      suggestedQuantity: ledgerEntry.suggestedQuantity ?? 1,
      offeredAt: ledgerEntry.openedAt ?? ledgerEntry.lastSurfacedAt ?? '',
      source: ledgerEntry.source,
    });
    if (fromLedger) return fromLedger;
  }
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
  const offeredAt = new Date().toISOString();
  const cat = getIntentCatalogEntry('CONFIRMAR_OFERTA');
  const expiresAt =
    cat.ttlMs != null
      ? new Date(Date.parse(offeredAt) + cat.ttlMs).toISOString()
      : null;

  await patchIntentLedgerEntry(params.conversationId, 'CONFIRMAR_OFERTA', {
    openedAt: offeredAt,
    expiresAt,
    surfaceCount: 0,
    lastSurfacedAt: null,
    productId: params.productId,
    productName: params.productName.trim(),
    suggestedQuantity,
    source: params.source,
  });

  // Flip: ya no escribimos el bag paralelo. Limpiamos legacy si existía.
  await omitConversationMetadataKeys(params.conversationId, ['lastOffer']);
  await setLastReferencedProductId(params.conversationId, params.productId);
};

export const clearLastOffer = async (conversationId: string): Promise<void> => {
  await patchIntentLedgerEntry(conversationId, 'CONFIRMAR_OFERTA', {});
  await omitConversationMetadataKeys(conversationId, ['lastOffer']);
};

export const recordConfirmOfferSurfaced = async (
  conversationId: string,
  metadata: unknown
): Promise<void> => {
  const meta = normalizeMetadata(metadata);
  const prev = meta.intentLedger?.CONFIRMAR_OFERTA ?? {};
  await patchIntentLedgerEntry(conversationId, 'CONFIRMAR_OFERTA', {
    ...prev,
    surfaceCount: (prev.surfaceCount ?? 0) + 1,
    lastSurfacedAt: new Date().toISOString(),
  });
};

/** Candidato para el ranker cuando hay oferta viva con permiso de catálogo. */
export const deriveConfirmOfferCandidate = (
  metadata: unknown,
  now: number = Date.now()
): IntentCandidate | null => {
  const meta = normalizeMetadata(metadata);
  const offer = getLastOffer(meta);
  if (!offer) return null;

  const entry = meta.intentLedger?.CONFIRMAR_OFERTA ?? {
    openedAt: offer.offeredAt,
    expiresAt: null,
    surfaceCount: 0,
  };
  // Si solo hay legacy lastOffer, sintetizar openedAt para el TTL.
  const ledgerForPerm = {
    ...entry,
    openedAt: entry.openedAt ?? offer.offeredAt,
  };
  const perm = computeCatalogPermission('CONFIRMAR_OFERTA', ledgerForPerm, now);
  if (!perm.granted) return null;

  const cat = getIntentCatalogEntry('CONFIRMAR_OFERTA');
  return {
    type: 'CONFIRMAR_OFERTA',
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint: buildConfirmOfferHint(offer),
    tieBreak: 20,
  };
};

export const buildConfirmOfferHint = (offer: LastOffer): string =>
  [
    `- Oferta activa (CONFIRMAR_OFERTA): *${offer.productName}* ` +
      `(productId: ${offer.productId}). Origen: ${offer.source}.`,
    '- REGLA OBLIGATORIA: el turno anterior terminó con una oferta activa al cliente. ' +
      'Si el mensaje actual NO es explícitamente negativo ("no", "mejor no", "cancelá", etc.), ' +
      'SIEMPRE interpretarlo como confirmación y llamar add_cart_item inmediatamente con el productId de arriba. ' +
      'NO saludar, NO preguntar "¿en qué te puedo ayudar?", NO pedir más confirmación. ' +
      'Cantidad: pasá quantity solo si el cliente dijo unidades en ESTE mensaje. ' +
      'Si no, omití quantity (no uses party size ni una cantidad sugerida). La tool pedirá confirmación si hace falta.',
  ].join('\n');

/**
 * Líneas legacy para tests / callers que aún no pasan por el ranker.
 * Respeta TTL: oferta vencida → no se inyecta (V-12).
 */
export const buildLastOfferContextLines = (
  metadata: unknown,
  now: number = Date.now()
): string[] => {
  const lines: string[] = [];
  const candidate = deriveConfirmOfferCandidate(metadata, now);
  if (candidate) {
    lines.push(...candidate.hint.split('\n'));
  }

  return lines;
};

/** Vista de Ledger para CONFIRMAR_OFERTA (para el ranker). */
export const getConfirmOfferLedgerEntry = (
  metadata: unknown
): NonNullable<ConversationMetadata['intentLedger']>['CONFIRMAR_OFERTA'] => {
  const meta = normalizeMetadata(metadata);
  const offer = getLastOffer(meta);
  const entry = meta.intentLedger?.CONFIRMAR_OFERTA;
  if (entry) {
    return {
      ...entry,
      openedAt: entry.openedAt ?? offer?.offeredAt ?? null,
    };
  }
  if (offer) {
    return {
      openedAt: offer.offeredAt,
      surfaceCount: 0,
      productId: offer.productId,
      productName: offer.productName,
      suggestedQuantity: offer.suggestedQuantity,
      source: offer.source,
    };
  }
  return undefined;
};
