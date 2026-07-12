/**
 * COMPLETAR_RESERVA — Goal derivado de reservas (Fase 1b del roadmap de
 * migración, ver docs/arquitectura/ROADMAP-MIGRACION.md).
 *
 * Mismo patrón que `orderCompletionGoal.service.ts` (Fase 0), aplicado a un
 * segundo dominio. Depende de `handback_reservation` (Fase 1b): a diferencia
 * de `abandon_reservation`, esa salida conserva `reservation_draft` — sin
 * eso, este Goal jamás podría estar abierto fuera de la sesión del agente de
 * reservas, porque el borrador no sobrevivía a ninguna salida.
 */

import { nextReservationDraftQuestion } from '../graph/nodes/session/buildResumeFollowUp';
import type { ReservationDraft } from '../graph/nodes/session/buildResumeFollowUp';
import { patchIntentLedgerEntry } from './intentLedger.repository';
import type { ConversationMetadata } from './productQuery/types';
import { normalizeMetadata } from './productQuery/utils';

export interface ReservationCompletionFacts {
  /** Hay un borrador de reserva en curso (al menos un campo cargado). */
  hasDraft: boolean;
  reservationAgentActive: boolean;
}

export interface ReservationCompletionLedger {
  abandonment: boolean;
  surfaceCount: number;
  lastSurfacedAt: string | null;
}

const EMPTY_LEDGER: ReservationCompletionLedger = {
  abandonment: false,
  surfaceCount: 0,
  lastSurfacedAt: null,
};

export const getReservationCompletionLedger = (metadata: unknown): ReservationCompletionLedger => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  return { ...EMPTY_LEDGER, ...(meta.intentLedger?.COMPLETAR_RESERVA ?? {}) };
};

export const hasReservationDraftInProgress = (draft: ReservationDraft | undefined): boolean =>
  Boolean(draft) && Object.keys(draft as object).length > 0;

export interface ReservationCompletionGoal {
  /** Abierto ⟺ hay un borrador en curso, el agente de reservas no tiene el turno, y no fue abandonado. */
  open: boolean;
}

/** Derivador puro (ADR-0005/0006). */
export const deriveReservationCompletionGoal = (
  facts: ReservationCompletionFacts,
  ledger: ReservationCompletionLedger
): ReservationCompletionGoal => ({
  open: facts.hasDraft && !facts.reservationAgentActive && !ledger.abandonment,
});

/** Presupuesto de insistencia (ADR-0008): 3 → enmudece, no muere. */
export const RESERVATION_COMPLETION_SURFACE_BUDGET = 3;

/** Cooldown entre planteos consecutivos del mismo Goal. */
export const RESERVATION_COMPLETION_COOLDOWN_MS = 10 * 60 * 1000;

export type ReservationCompletionPermissionReason =
  | 'granted'
  | 'closed'
  | 'budget_exhausted'
  | 'cooldown'
  | 'suppressed_by_saliency';

export interface ReservationCompletionPermission {
  granted: boolean;
  reason: ReservationCompletionPermissionReason;
}

/** Permiso que calcula el sistema (ADR-0009/0010). */
export const computeReservationCompletionPermission = (
  goal: ReservationCompletionGoal,
  ledger: ReservationCompletionLedger,
  now: number = Date.now()
): ReservationCompletionPermission => {
  if (!goal.open) return { granted: false, reason: 'closed' };
  if (ledger.surfaceCount >= RESERVATION_COMPLETION_SURFACE_BUDGET) {
    return { granted: false, reason: 'budget_exhausted' };
  }
  if (
    ledger.lastSurfacedAt &&
    now - new Date(ledger.lastSurfacedAt).getTime() < RESERVATION_COMPLETION_COOLDOWN_MS
  ) {
    return { granted: false, reason: 'cooldown' };
  }
  return { granted: true, reason: 'granted' };
};

const patchLedger = (conversationId: string, ledger: ReservationCompletionLedger): Promise<void> =>
  patchIntentLedgerEntry(conversationId, 'COMPLETAR_RESERVA', ledger);

/** Registra que el Goal se planteó este turno (consume presupuesto de insistencia). */
export const recordReservationCompletionSurfaced = async (
  conversationId: string,
  ledger: ReservationCompletionLedger
): Promise<void> => {
  await patchLedger(conversationId, {
    ...ledger,
    surfaceCount: ledger.surfaceCount + 1,
    lastSurfacedAt: new Date().toISOString(),
  });
};

/** El cliente pidió explícitamente que no insistamos con la reserva. NO borra el borrador. */
export const recordReservationCompletionAbandonment = async (
  conversationId: string,
  ledger: ReservationCompletionLedger
): Promise<void> => {
  await patchLedger(conversationId, { ...ledger, abandonment: true });
};

/** Revival (ADR-0005, corolario): si el cliente retoma la reserva, el abandono se limpia solo. */
export const reviveReservationCompletionIfAbandoned = async (
  conversationId: string,
  ledger: ReservationCompletionLedger
): Promise<void> => {
  if (!ledger.abandonment && ledger.surfaceCount === 0) return;
  await patchLedger(conversationId, EMPTY_LEDGER);
};

/**
 * Líneas para inyectar en `[ESTADO DEL CLIENTE]` del hybrid agent + logging
 * obligatorio del Ledger (ADR-0007).
 */
export const buildReservationCompletionContextLines = (params: {
  facts: ReservationCompletionFacts;
  ledger: ReservationCompletionLedger;
  conversationId: string;
  draft: ReservationDraft | undefined;
  hasEnvironments: boolean;
  /** ADR-0009: a lo sumo un Intent activo por turno — lo decide el arbitraje del caller. */
  suppressedBySaliency?: boolean;
}): string[] => {
  const { facts, ledger, conversationId, draft, hasEnvironments, suppressedBySaliency } = params;
  const goal = deriveReservationCompletionGoal(facts, ledger);
  const rawPermission = computeReservationCompletionPermission(goal, ledger);
  const permission: ReservationCompletionPermission =
    suppressedBySaliency && rawPermission.granted
      ? { granted: false, reason: 'suppressed_by_saliency' }
      : rawPermission;

  console.log(
    JSON.stringify({
      event: '[goal] reservation_completion_ledger',
      conversationId,
      open: goal.open,
      permission: permission.reason,
      surfaceCount: ledger.surfaceCount,
      abandonment: ledger.abandonment,
    })
  );

  if (!permission.granted) return [];

  void recordReservationCompletionSurfaced(conversationId, ledger).catch((err) =>
    console.error('[goal] failed to record reservation completion surfaced:', err)
  );

  const missing = nextReservationDraftQuestion(draft, hasEnvironments);
  const missingLabel = missing ? ` (falta: ${missing})` : '';

  return [
    '- Objetivo abierto (COMPLETAR_RESERVA): el cliente tiene una reserva sin terminar' +
      `${missingLabel}. Si es natural en este turno —después de responder lo que preguntó, ` +
      'y solo si tu respuesta no deja una pregunta abierta— podés ofrecerle continuar con la ' +
      'reserva. No lo menciones si no viene al caso. Si el cliente pide explícitamente que no ' +
      'insistas más, usá la tool `abandon_pending_reservation` (no borra el borrador).',
  ];
};
