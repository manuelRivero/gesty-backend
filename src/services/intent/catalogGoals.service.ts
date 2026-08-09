/**
 * Goals de catálogo cableados en Fase E (además de COMPLETAR_PEDIDO / RESERVA).
 * Derivadores puros; el ranker decide permiso y saliencia.
 */

import { getIntentCatalogEntry, type IntentCandidate } from '../../domain/intent/family';
import { computeCatalogPermission, type IntentLedgerEntry } from './activeIntent.service';
import type { ConversationMetadata } from '../productQuery/types';
import { normalizeMetadata } from '../productQuery/utils';
import { patchIntentLedgerEntry } from '../intentLedger.repository';

export type ConfirmarPagoOnlineFacts = {
  /** Hay un payment_intent pending con init_point (link emitido). */
  paymentLinkEmitted: boolean;
  /** payment_status === paid (o equivalente). */
  paymentAccredited: boolean;
};

export const deriveConfirmarPagoOnlineOpen = (facts: ConfirmarPagoOnlineFacts): boolean =>
  facts.paymentLinkEmitted && !facts.paymentAccredited;

export const deriveConfirmarPagoOnlineCandidate = (
  facts: ConfirmarPagoOnlineFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  if (!deriveConfirmarPagoOnlineOpen(facts)) return null;
  if (ledgerEntry?.abandonment) return null;
  const perm = computeCatalogPermission('CONFIRMAR_PAGO_ONLINE', ledgerEntry ?? {}, now);
  if (!perm.granted) return null;

  const cat = getIntentCatalogEntry('CONFIRMAR_PAGO_ONLINE');
  return {
    type: 'CONFIRMAR_PAGO_ONLINE',
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint:
      '- Objetivo abierto (CONFIRMAR_PAGO_ONLINE): se emitió un link de pago y todavía ' +
      'no está acreditado. Si es natural, recordále completar el pago. No declares "listo" ' +
      'vos — el sistema cierra cuando el Fact de pago cambia.',
    tieBreak: 90,
  };
};

export type DesbloquearPedidoCerradoFacts = {
  /** Ítem pendiente por negocio cerrado (`pending_closed_add_item`). */
  pendingClosedAddItem: boolean;
};

export const deriveDesbloquearPedidoCerradoOpen = (
  facts: DesbloquearPedidoCerradoFacts
): boolean => facts.pendingClosedAddItem;

export const deriveDesbloquearPedidoCerradoCandidate = (
  facts: DesbloquearPedidoCerradoFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  if (!deriveDesbloquearPedidoCerradoOpen(facts)) return null;
  if (ledgerEntry?.abandonment) return null;
  const perm = computeCatalogPermission('DESBLOQUEAR_PEDIDO_CERRADO', ledgerEntry ?? {}, now);
  if (!perm.granted) return null;

  const cat = getIntentCatalogEntry('DESBLOQUEAR_PEDIDO_CERRADO');
  return {
    type: 'DESBLOQUEAR_PEDIDO_CERRADO',
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint:
      '- Objetivo abierto (DESBLOQUEAR_PEDIDO_CERRADO): hay un ítem pendiente porque el ' +
      'negocio está cerrado. Ayudá al cliente a confirmar si quiere pedirlo igual o desistir. ' +
      'Se cierra cuando confirma, desiste o el negocio abre.',
    tieBreak: 80,
  };
};

export type RetomarTareaFacts = {
  /** Snapshot de tarea interrumpida (hoy: peopleCountResume). */
  hasInterruptedTask: boolean;
};

export const deriveRetomarTareaOpen = (facts: RetomarTareaFacts): boolean =>
  facts.hasInterruptedTask;

export const deriveRetomarTareaCandidate = (
  facts: RetomarTareaFacts,
  ledgerEntry: IntentLedgerEntry | undefined,
  now: number = Date.now()
): IntentCandidate | null => {
  if (!deriveRetomarTareaOpen(facts)) return null;
  const perm = computeCatalogPermission('RETOMAR_TAREA_INTERRUMPIDA', ledgerEntry ?? {}, now);
  if (!perm.granted) return null;

  const cat = getIntentCatalogEntry('RETOMAR_TAREA_INTERRUMPIDA');
  return {
    type: 'RETOMAR_TAREA_INTERRUMPIDA',
    kind: cat.kind,
    pressure: cat.pressure,
    closeMode: cat.closeMode,
    hint:
      '- Objetivo abierto (RETOMAR_TAREA_INTERRUMPIDA): hay una consulta de comida ' +
      'congelada esperando el número de personas. Priorizá obtener ese dato para reanudar. ' +
      'No inventes el cierre desde el prompt.',
    tieBreak: 85,
  };
};

export const recordCatalogGoalSurfaced = async (
  conversationId: string,
  type: 'CONFIRMAR_PAGO_ONLINE' | 'DESBLOQUEAR_PEDIDO_CERRADO' | 'RETOMAR_TAREA_INTERRUMPIDA',
  metadata: unknown
): Promise<void> => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  const prev = meta.intentLedger?.[type] ?? {};
  await patchIntentLedgerEntry(conversationId, type, {
    ...prev,
    surfaceCount: (prev.surfaceCount ?? 0) + 1,
    lastSurfacedAt: new Date().toISOString(),
  });
};
