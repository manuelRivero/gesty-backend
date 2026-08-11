/**
 * OBTENER_PERSONAS_DEL_PEDIDO — Goal blocking (PLAN-ACCION-PARTY-SIZE-GOAL).
 *
 * Sin Fact PERSONAS_DEL_PEDIDO no hay porciones/recomendaciones útiles.
 * Proyección pura sobre Facts + señal de comida; Ledger de insistencia aparte.
 * Alias ledger legacy: RECOLECTAR_PARTY_SIZE (migración suave).
 */

import { getIntentCatalogEntry, type IntentCandidate } from '../domain/intent/family';
import { computeCatalogPermission, type IntentLedgerEntry } from './intent/activeIntent.service';
import { patchIntentLedgerEntry } from './intentLedger.repository';
import type { ConversationMetadata } from './productQuery/types';
import { normalizeMetadata } from './productQuery/utils';

export const PARTY_SIZE_GOAL_TYPE = 'OBTENER_PERSONAS_DEL_PEDIDO' as const;
/** Key histórica en intentLedger (Opportunity ambient C.3). */
export const PARTY_SIZE_GOAL_LEGACY_TYPE = 'RECOLECTAR_PARTY_SIZE' as const;

/**
 * Intents NLP como feature de apertura (Fase A — deuda documentada).
 * Prohibido inyectar el intent como hint al agente.
 */
export const FOOD_RELATED_INTENTS_FOR_PARTY_SIZE = new Set([
  'ORDER_FOOD',
  'PRODUCT_QUERY',
  'ADD_ITEM',
  'VIEW_MENU',
  'MODIFY_QUANTITY',
  'RECOMMENDATION_REQUEST',
  'PRODUCT_ATTRIBUTE_QUESTION',
]);

export type PartySizeGoalFacts = {
  /** Fact PERSONAS_DEL_PEDIDO ausente. */
  partySize: number | null;
  /** Señal de comida (turno NLP Fase A y/o metadata Fase B). */
  foodRelatedSignal: boolean;
  checkoutActive: boolean;
};

export type PartySizeGoalLedger = {
  abandonment: boolean;
  surfaceCount: number;
  lastSurfacedAt: string | null;
};

const EMPTY_LEDGER: PartySizeGoalLedger = {
  abandonment: false,
  surfaceCount: 0,
  lastSurfacedAt: null,
};

/** Lee ledger nuevo o legacy RECOLECTAR_PARTY_SIZE. */
export const getPartySizeGoalLedger = (metadata: unknown): PartySizeGoalLedger => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  const ledger = meta.intentLedger;
  const entry =
    ledger?.[PARTY_SIZE_GOAL_TYPE] ??
    (ledger as Record<string, IntentLedgerEntry> | undefined)?.[PARTY_SIZE_GOAL_LEGACY_TYPE];
  return {
    abandonment: entry?.abandonment === true,
    surfaceCount: entry?.surfaceCount ?? 0,
    lastSurfacedAt: entry?.lastSurfacedAt ?? null,
  };
};

export type PartySizeGoal = {
  open: boolean;
};

/** Derivador puro: abierto ⟺ falta Fact + señal comida + no checkout + no abandono. */
export const derivePartySizeGoal = (
  facts: PartySizeGoalFacts,
  ledger: PartySizeGoalLedger
): PartySizeGoal => ({
  open:
    facts.partySize == null &&
    facts.foodRelatedSignal &&
    !facts.checkoutActive &&
    !ledger.abandonment,
});

/**
 * Señal “el usuario pregunta por comida” sin Ownership.
 * Fase A: intents NLP. Fase B: shortlist / offer / CTA / producto referenciado.
 */
export const isFoodRelatedPartySizeSignal = (params: {
  detectionIntent?: string | null;
  metadata: ConversationMetadata;
  lastReferencedProductId?: string | null;
}): boolean => {
  const intent = params.detectionIntent;
  if (intent && FOOD_RELATED_INTENTS_FOR_PARTY_SIZE.has(String(intent))) {
    return true;
  }
  const meta = params.metadata;
  if (meta.pendingProductSelection === true) return true;
  if ((meta.candidateProductIds?.length ?? 0) > 0) return true;
  if (meta.lastOffer?.kind === 'ADD_ITEM') return true;
  if (meta.lastCtaProductId) return true;
  if (params.lastReferencedProductId) return true;
  return false;
};

export const derivePartySizeGoalCandidate = (
  facts: PartySizeGoalFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  const ledger: PartySizeGoalLedger = {
    abandonment: ledgerEntry?.abandonment === true,
    surfaceCount: ledgerEntry?.surfaceCount ?? 0,
    lastSurfacedAt: ledgerEntry?.lastSurfacedAt ?? null,
  };
  if (!derivePartySizeGoal(facts, ledger).open) return null;

  const perm = computeCatalogPermission(PARTY_SIZE_GOAL_TYPE, ledgerEntry ?? {}, now);
  if (!perm.granted) return null;

  const cat = getIntentCatalogEntry(PARTY_SIZE_GOAL_TYPE);
  return {
    type: PARTY_SIZE_GOAL_TYPE,
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint:
      '- Goal (OBTENER_PERSONAS_DEL_PEDIDO, blocking): falta cuántas personas comen. ' +
      'Antes de recomendar platos o sumar al carrito, preguntá el número (1–99) de forma breve. ' +
      'Cuando el cliente lo diga, persistilo con save_party_size y recién ahí continuá con la comida del turno. ' +
      'Si ya había una búsqueda/shortlist pendiente, retomalá después de guardar personas.',
    tieBreak: 95,
  };
};

/** Resuelve entry de ledger (nuevo o legacy) para el ranker / surface. */
export const resolvePartySizeLedgerEntry = (
  metadata: unknown
): IntentLedgerEntry | undefined => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  const ledger = meta.intentLedger;
  return (
    ledger?.[PARTY_SIZE_GOAL_TYPE] ??
    (ledger as Record<string, IntentLedgerEntry> | undefined)?.[PARTY_SIZE_GOAL_LEGACY_TYPE]
  );
};

export const recordPartySizeGoalSurfaced = async (
  conversationId: string,
  metadata: unknown
): Promise<void> => {
  const prev = resolvePartySizeLedgerEntry(metadata) ?? {};
  await patchIntentLedgerEntry(conversationId, PARTY_SIZE_GOAL_TYPE, {
    ...prev,
    surfaceCount: (prev.surfaceCount ?? 0) + 1,
    lastSurfacedAt: new Date().toISOString(),
  });
};

export const recordPartySizeGoalAbandonment = async (
  conversationId: string,
  metadata: unknown
): Promise<void> => {
  const prev = resolvePartySizeLedgerEntry(metadata) ?? {};
  await patchIntentLedgerEntry(conversationId, PARTY_SIZE_GOAL_TYPE, {
    ...prev,
    abandonment: true,
  });
};
