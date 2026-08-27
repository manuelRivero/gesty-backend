/**
 * CONFIRMAR_OFERTA — Opportunity (TAXONOMIA §3 / Fase B.2) + Fact de sesión.
 *
 * El Ledger guarda el dato de la oferta (`productId`, …) y el presupuesto
 * de planteo (`surfaceCount`). Son dos canales:
 * - Fact (`buildLastOfferFactLines`): visible mientras la oferta viva y el
 *   TTL del catálogo no venció — independiente de maxSurfaces.
 * - Opportunity (`deriveConfirmOfferCandidate`): permiso de plantear; el
 *   ranker gasta `surfaceCount` al inyectar el hint (no al confirmar).
 *
 * `getLastOffer` lee el row crudo (sin TTL). El TTL del Fact es
 * `isLastOfferAlive`. Presupuesto 1 = anti-nag del planteo (ADR-0008 / D7).
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

/** TTL del catálogo CONFIRMAR_OFERTA (misma fórmula que `computeCatalogPermission`). */
const isConfirmOfferTtlValid = (
  entry: { openedAt?: string | null; expiresAt?: string | null },
  now: number
): boolean => {
  const cat = getIntentCatalogEntry('CONFIRMAR_OFERTA');
  if (cat.ttlMs == null) return true;
  const expiresAt =
    entry.expiresAt ??
    (entry.openedAt
      ? new Date(new Date(entry.openedAt).getTime() + cat.ttlMs).toISOString()
      : null);
  if (expiresAt && now > new Date(expiresAt).getTime()) return false;
  return true;
};

/**
 * Oferta con dato usable: hay lastOffer y el TTL no venció.
 * No mira `surfaceCount` (el presupuesto es del planteo, no del Fact).
 */
export const isLastOfferAlive = (
  metadata: unknown,
  now: number = Date.now()
): boolean => {
  const offer = getLastOffer(metadata);
  if (!offer) return false;
  const entry = getConfirmOfferLedgerEntry(metadata);
  return isConfirmOfferTtlValid(
    {
      openedAt: entry?.openedAt ?? offer.offeredAt,
      expiresAt: entry?.expiresAt ?? null,
    },
    now
  );
};

/**
 * Dato de sesión para el ReAct (no es un Intent planteado, ADR-0009).
 * Vacío si no hay oferta o el TTL venció.
 */
export const buildLastOfferFactLines = (
  metadata: unknown,
  now: number = Date.now()
): string[] => {
  if (!isLastOfferAlive(metadata, now)) return [];
  const offer = getLastOffer(metadata);
  if (!offer) return [];
  return [
    `- Oferta viva (dato de sesión, no planteo): *${offer.productName}* ` +
      `(productId: ${offer.productId}). ` +
      `Si el cliente confirma sumar, llamá add_cart_item con ese productId. ` +
      `Si pregunta precio o atributo, get_products_details_by_ids; no es un add. ` +
      `No insistas ni vuelvas a ofrecer el plato.`,
  ];
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
    `- Oferta activa (CONFIRMAR_OFERTA): planteo permitido este turno para *${offer.productName}*. ` +
      `Confirmación de sumar → add_cart_item con el productId de Oferta viva. ` +
      `Pregunta de precio o atributo → get_products_details_by_ids; no es confirmación. ` +
      `Rechazo → no llames add_cart_item. ` +
      `Cantidad: pasá quantity solo si el cliente dijo unidades en ESTE mensaje. ` +
      `Si no, omití quantity (no uses party size ni una cantidad sugerida).`,
  ].join('\n');

/**
 * Opportunity (si hay permiso de planteo) + Fact (si TTL vivo).
 * Oferta vencida → []. Presupuesto exhausted → solo Fact.
 */
export const buildLastOfferContextLines = (
  metadata: unknown,
  now: number = Date.now()
): string[] => {
  const lines = [...buildLastOfferFactLines(metadata, now)];
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
