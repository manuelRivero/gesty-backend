/**
 * Derivadores de Alerts de catálogo (Fase D).
 * Cierre por emisión (Ledger.emitted) salvo las que exigen resolución (Fact).
 * Críticas: el cliente no puede silenciarlas (ADR-0008).
 */

import { getIntentCatalogEntry, type IntentCandidate } from '../../domain/intent/family';
import { isDraftOrderWorkerEnabled } from '../../config/env';
import { computeCatalogPermission, type IntentLedgerEntry } from './activeIntent.service';
import type { ConversationMetadata } from '../productQuery/types';
import { normalizeMetadata } from '../productQuery/utils';
import { patchIntentLedgerEntry } from '../intentLedger.repository';

/** Ventana por defecto para avisar que el borrador vence (minutos). */
export const PEDIDO_POR_EXPIRAR_WINDOW_MS = 5 * 60 * 1000;

export type PedidoPorExpirarFacts = {
  hasItems: boolean;
  expiresAt: Date | string | null;
};

export const derivePedidoPorExpirarOpen = (
  facts: PedidoPorExpirarFacts,
  now: number = Date.now()
): boolean => {
  // Sin worker no hay cierre real del draft: el aviso es ruido y tapa Opportunities.
  if (!isDraftOrderWorkerEnabled()) return false;
  if (!facts.hasItems || !facts.expiresAt) return false;
  const expiresMs =
    typeof facts.expiresAt === 'string'
      ? Date.parse(facts.expiresAt)
      : facts.expiresAt.getTime();
  if (Number.isNaN(expiresMs)) return false;
  const remaining = expiresMs - now;
  return remaining > 0 && remaining <= PEDIDO_POR_EXPIRAR_WINDOW_MS;
};

export const derivePedidoPorExpirarCandidate = (
  facts: PedidoPorExpirarFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  if (!derivePedidoPorExpirarOpen(facts, now)) return null;
  const perm = computeCatalogPermission('PEDIDO_POR_EXPIRAR', ledgerEntry ?? {}, now);
  if (!perm.granted) return null;

  const cat = getIntentCatalogEntry('PEDIDO_POR_EXPIRAR');
  return {
    type: 'PEDIDO_POR_EXPIRAR',
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint:
      '- Alert (PEDIDO_POR_EXPIRAR): el borrador del pedido está por vencer. ' +
      'Informá al cliente con claridad — es un deber del sistema, no una sugerencia. ' +
      'No se silencia con abandono.',
    tieBreak: 200,
  };
};

export type FueraDeCoberturaFacts = {
  hasAddress: boolean;
  isInCoverage: boolean;
};

export const deriveFueraDeCoberturaOpen = (facts: FueraDeCoberturaFacts): boolean =>
  facts.hasAddress && !facts.isInCoverage;

export const deriveFueraDeCoberturaCandidate = (
  facts: FueraDeCoberturaFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  if (!deriveFueraDeCoberturaOpen(facts)) return null;
  const perm = computeCatalogPermission('FUERA_DE_COBERTURA', ledgerEntry ?? {}, now);
  if (!perm.granted) return null;

  const cat = getIntentCatalogEntry('FUERA_DE_COBERTURA');
  return {
    type: 'FUERA_DE_COBERTURA',
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint:
      '- Alert (FUERA_DE_COBERTURA): la dirección del cliente está fuera de zona. ' +
      'Informá el problema y pedí otra dirección o ofrecé retiro si aplica. ' +
      'No alcanza con avisarlo una vez si sigue fuera — se cierra cuando hay dirección en cobertura. ' +
      'Bloquea Opportunities; no se silencia con abandono.',
    tieBreak: 250,
  };
};

export type EmissionAlertType = 'PEDIDO_POR_EXPIRAR' | 'NEGOCIO_POR_CERRAR' | 'ITEM_SIN_STOCK' | 'RESERVA_PROXIMA';
export type ResolutionAlertType = 'FUERA_DE_COBERTURA' | 'PAGO_RECHAZADO';

/** Al emitir Alert de cierre por emisión: `emitted = true` (no vuelve). */
export const recordAlertEmitted = async (
  conversationId: string,
  type: EmissionAlertType,
  metadata: unknown
): Promise<void> => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  const prev = meta.intentLedger?.[type] ?? {};
  await patchIntentLedgerEntry(conversationId, type, {
    ...prev,
    emitted: true,
    surfaceCount: (prev.surfaceCount ?? 0) + 1,
    lastSurfacedAt: new Date().toISOString(),
  });
};

/**
 * Alert que exige resolución: registra planteo (presupuesto 1) pero NO cierra
 * por `emitted` — el cierre es cambio de Fact (dirección en zona / pago ok).
 */
export const recordResolutionAlertSurfaced = async (
  conversationId: string,
  type: ResolutionAlertType,
  metadata: unknown
): Promise<void> => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  const prev = meta.intentLedger?.[type] ?? {};
  await patchIntentLedgerEntry(conversationId, type, {
    ...prev,
    // emitted marca que se avisó; computeCatalogPermission usa surfaceCount
    // para no re-plantear, no `emitted` como cierre suficiente.
    emitted: true,
    surfaceCount: (prev.surfaceCount ?? 0) + 1,
    lastSurfacedAt: new Date().toISOString(),
  });
};

/** Críticas: abandonar Intent no aplica (ADR-0008). */
export const isCriticalAlert = (type: string): boolean => {
  try {
    return getIntentCatalogEntry(type as Parameters<typeof getIntentCatalogEntry>[0]).critical;
  } catch {
    return false;
  }
};
