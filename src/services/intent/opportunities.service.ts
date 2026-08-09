/**
 * Derivadores puros de Opportunities de catálogo (Fase C).
 * Emisión al ranker vía `IntentCandidate`; presupuesto 1 lo aplica el catálogo.
 */

import type { MenuCategoryTag } from '@prisma/client';
import { getIntentCatalogEntry, type IntentCandidate } from '../../domain/intent/family';
import { computeCatalogPermission, type IntentLedgerEntry } from './activeIntent.service';
import type { ConversationMetadata } from '../productQuery/types';
import { normalizeMetadata } from '../productQuery/utils';
import { patchIntentLedgerEntry } from '../intentLedger.repository';

export type SuggestComplementFacts = {
  /** Tags presentes en el carrito (MAIN, DRINK, …). */
  cartTags: ReadonlySet<MenuCategoryTag>;
  checkoutActive: boolean;
};

/** Principales sin bebida ni postre → Opportunity abierta (TAXONOMIA §3). */
export const deriveSuggestComplementOpen = (facts: SuggestComplementFacts): boolean => {
  if (facts.checkoutActive) return false;
  if (!facts.cartTags.has('MAIN')) return false;
  return !facts.cartTags.has('DRINK') || !facts.cartTags.has('DESSERT');
};

export const deriveSuggestComplementCandidate = (
  facts: SuggestComplementFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  if (!deriveSuggestComplementOpen(facts)) return null;
  const perm = computeCatalogPermission('SUGERIR_COMPLEMENTO', ledgerEntry ?? {}, now);
  if (!perm.granted) return null;

  const missing: string[] = [];
  if (!facts.cartTags.has('DRINK')) missing.push('bebida');
  if (!facts.cartTags.has('DESSERT')) missing.push('postre');
  const cat = getIntentCatalogEntry('SUGERIR_COMPLEMENTO');
  return {
    type: 'SUGERIR_COMPLEMENTO',
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint:
      `- Opportunity (SUGERIR_COMPLEMENTO): el pedido tiene principal(es) y todavía no suma ` +
      `${missing.join(' ni ')}. Si es natural —después de responder lo que preguntó y sin ` +
      `dejar una pregunta abierta— podés ofrecer sumar ${missing.join(' o ')}. ` +
      `Una sola vez; no insistas.`,
    tieBreak: 15,
  };
};

export type SuggestAddressFacts = {
  hasAddress: boolean;
  /** Ownership de checkout activo o captura de dirección en curso. */
  blockingAddressIntent: boolean;
};

export const deriveSuggestAddressOpen = (facts: SuggestAddressFacts): boolean =>
  !facts.hasAddress && !facts.blockingAddressIntent;

export const deriveSuggestAddressCandidate = (
  facts: SuggestAddressFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  if (!deriveSuggestAddressOpen(facts)) return null;
  const perm = computeCatalogPermission('SUGERIR_DIRECCION', ledgerEntry ?? {}, now);
  if (!perm.granted) return null;

  const cat = getIntentCatalogEntry('SUGERIR_DIRECCION');
  return {
    type: 'SUGERIR_DIRECCION',
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint:
      '- Opportunity (SUGERIR_DIRECCION): el cliente no tiene dirección guardada. ' +
      'Si encaja naturalmente (p. ej. habla de delivery o de agilizar), podés sugerirle ' +
      'cargarla. No es obligatorio; presupuesto 1 — no insistas.',
    tieBreak: 12,
  };
};

export type CollectPartySizeFacts = {
  /** Consulta de comida / pedido en este turno (señal del detection). */
  foodRelatedTurn: boolean;
  partySize: number | null;
  checkoutActive: boolean;
};

export const deriveCollectPartySizeOpen = (facts: CollectPartySizeFacts): boolean =>
  facts.foodRelatedTurn && facts.partySize == null && !facts.checkoutActive;

export const deriveCollectPartySizeCandidate = (
  facts: CollectPartySizeFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  if (!deriveCollectPartySizeOpen(facts)) return null;
  const perm = computeCatalogPermission('RECOLECTAR_PARTY_SIZE', ledgerEntry ?? {}, now);
  if (!perm.granted) return null;

  const cat = getIntentCatalogEntry('RECOLECTAR_PARTY_SIZE');
  return {
    type: 'RECOLECTAR_PARTY_SIZE',
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint:
      '- Opportunity (RECOLECTAR_PARTY_SIZE): el cliente consulta comida y no informó ' +
      'cuántas personas. Si es natural, preguntá el número una sola vez. No mezclar con ' +
      'ruteo ni Ownership.',
    tieBreak: 14,
  };
};

export const recordOpportunitySurfaced = async (
  conversationId: string,
  type: 'SUGERIR_COMPLEMENTO' | 'SUGERIR_DIRECCION' | 'RECOLECTAR_PARTY_SIZE' | 'OFRECER_PROMOCION',
  metadata: unknown
): Promise<void> => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  const prev = meta.intentLedger?.[type] ?? {};
  const openedAt = prev.openedAt ?? new Date().toISOString();
  const cat = getIntentCatalogEntry(type);
  await patchIntentLedgerEntry(conversationId, type, {
    ...prev,
    openedAt,
    expiresAt:
      prev.expiresAt ??
      (cat.ttlMs != null
        ? new Date(Date.parse(openedAt) + cat.ttlMs).toISOString()
        : null),
    surfaceCount: (prev.surfaceCount ?? 0) + 1,
    lastSurfacedAt: new Date().toISOString(),
  });
};
