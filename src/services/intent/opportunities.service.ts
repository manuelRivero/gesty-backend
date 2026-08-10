/**
 * Derivadores puros de Opportunities de catálogo (Fase C).
 * Emisión al ranker vía `IntentCandidate`; permiso por catálogo / reglas propias.
 */

import type { MenuCategoryTag } from '@prisma/client';
import { getIntentCatalogEntry, type IntentCandidate } from '../../domain/intent/family';
import { getMissingMenuCompleteTags } from '../../helpers/complementaryMenu.helper';
import { computeCatalogPermission, type IntentLedgerEntry } from './activeIntent.service';
import type { ConversationMetadata } from '../productQuery/types';
import { normalizeMetadata } from '../productQuery/utils';
import { patchIntentLedgerEntry } from '../intentLedger.repository';
import { prisma } from '../../lib/prisma';

const MENU_COMPLETE_LABEL: Partial<Record<MenuCategoryTag, string>> = {
  STARTER: 'entrada',
  MAIN: 'plato principal',
  DRINK: 'bebida',
  DESSERT: 'postre',
};

export type SuggestComplementFacts = {
  /** Tags presentes en el carrito (MAIN, DRINK, …). */
  cartTags: ReadonlySet<MenuCategoryTag>;
  checkoutActive: boolean;
};

export type SuggestComplementPermissionDenial =
  | 'not_open'
  | 'refused'
  | 'awaiting_engagement'
  | 'budget_exhausted'
  | 'cooldown'
  | 'expired'
  | 'ok';

/**
 * Permiso de SUGERIR_COMPLEMENTO:
 * - «no» (refused) → fin de la vida
 * - tras la 1ª ola sin engaged → no más hasta que acepte/sume de la oferta
 * - con engaged → cooldown + tope de olas (maxSurfaces)
 */
export const computeSuggestComplementPermission = (
  entry: IntentLedgerEntry,
  now: number = Date.now()
): { granted: boolean; reason: SuggestComplementPermissionDenial } => {
  if (entry.refused) {
    return { granted: false, reason: 'refused' };
  }

  const cat = getIntentCatalogEntry('SUGERIR_COMPLEMENTO');
  const surfaceCount = entry.surfaceCount ?? 0;
  const engaged = entry.engaged === true;

  if (surfaceCount >= 1 && !engaged) {
    return { granted: false, reason: 'awaiting_engagement' };
  }

  if (engaged && surfaceCount >= cat.maxSurfaces) {
    return { granted: false, reason: 'budget_exhausted' };
  }

  if (
    cat.cooldownMs > 0 &&
    entry.lastSurfacedAt &&
    now - new Date(entry.lastSurfacedAt).getTime() < cat.cooldownMs
  ) {
    return { granted: false, reason: 'cooldown' };
  }

  if (cat.ttlMs != null) {
    const expiresAt =
      entry.expiresAt ??
      (entry.openedAt
        ? new Date(new Date(entry.openedAt).getTime() + cat.ttlMs).toISOString()
        : null);
    if (expiresAt && now > new Date(expiresAt).getTime()) {
      return { granted: false, reason: 'expired' };
    }
  }

  return { granted: true, reason: 'ok' };
};

/** Cualquier ítem en carrito con huecos STARTER/MAIN/DRINK/DESSERT → Opportunity abierta. */
export const deriveSuggestComplementOpen = (facts: SuggestComplementFacts): boolean => {
  if (facts.checkoutActive) return false;
  if (facts.cartTags.size === 0) return false;
  return getMissingMenuCompleteTags(facts.cartTags).length > 0;
};

export const deriveSuggestComplementCandidate = (
  facts: SuggestComplementFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  if (!deriveSuggestComplementOpen(facts)) return null;
  const perm = computeSuggestComplementPermission(ledgerEntry ?? {}, now);
  if (!perm.granted) return null;

  const missing = getMissingMenuCompleteTags(facts.cartTags);
  const missingLabels = missing.map((t) => MENU_COMPLETE_LABEL[t] ?? t);
  const offerHint =
    missingLabels.length <= 2
      ? missingLabels.join(' y ')
      : `${missingLabels.slice(0, 2).join(' y ')} (u otras faltantes)`;
  const cat = getIntentCatalogEntry('SUGERIR_COMPLEMENTO');
  return {
    type: 'SUGERIR_COMPLEMENTO',
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint:
      `- Opportunity opcional (SUGERIR_COMPLEMENTO): el pedido puede completarse; faltan ` +
      `${missingLabels.join(', ')}. Tras agregar un ítem, si es natural —y sin dejar pregunta ` +
      `abierta— ofrecé hasta 2 categorías oportunas con present_complement_suggestions ` +
      `(prioridad sugerida: ${offerHint}). Si el cliente dice no / mejor no / sin eso, ` +
      `llamá mark_complement_refused y no vuelvas a ofrecer. Si acepta o suma de la lista, ` +
      `podés ofrecer otra ola más adelante (no en cada mensaje).`,
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
  metadata: unknown,
  opts?: { offeredProductIds?: string[] }
): Promise<void> => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  const prev = meta.intentLedger?.[type] ?? {};
  const openedAt = prev.openedAt ?? new Date().toISOString();
  const cat = getIntentCatalogEntry(type);
  const patch: IntentLedgerEntry = {
    ...prev,
    openedAt,
    expiresAt:
      prev.expiresAt ??
      (cat.ttlMs != null
        ? new Date(Date.parse(openedAt) + cat.ttlMs).toISOString()
        : null),
    surfaceCount: (prev.surfaceCount ?? 0) + 1,
    lastSurfacedAt: new Date().toISOString(),
  };
  if (type === 'SUGERIR_COMPLEMENTO' && opts?.offeredProductIds?.length) {
    patch.lastOfferedProductIds = opts.offeredProductIds;
  }
  await patchIntentLedgerEntry(conversationId, type, patch);
};

/** Cierre duro: el cliente rechazó completar el menú. */
export const markComplementRefused = async (conversationId: string): Promise<void> => {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  const meta = normalizeMetadata(row?.metadata);
  const prev = meta.intentLedger?.SUGERIR_COMPLEMENTO ?? {};
  await patchIntentLedgerEntry(conversationId, 'SUGERIR_COMPLEMENTO', {
    ...prev,
    refused: true,
    lastSurfacedAt: prev.lastSurfacedAt ?? new Date().toISOString(),
  });
};

/**
 * Si el producto sumado estaba en la última oferta, marca engaged
 * (habilita olas futuras con cooldown).
 */
export const markComplementEngagedIfOffered = async (
  conversationId: string,
  productId: string
): Promise<boolean> => {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  const meta = normalizeMetadata(row?.metadata);
  const prev = meta.intentLedger?.SUGERIR_COMPLEMENTO ?? {};
  if (prev.refused) return false;
  const offered = prev.lastOfferedProductIds ?? [];
  if (!offered.includes(productId)) return false;
  await patchIntentLedgerEntry(conversationId, 'SUGERIR_COMPLEMENTO', {
    ...prev,
    engaged: true,
  });
  return true;
};
