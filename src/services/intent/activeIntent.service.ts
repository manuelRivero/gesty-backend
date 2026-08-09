/**
 * Derivador + ranker de la familia Intent (ADR-0008 / ADR-0009).
 *
 * Un solo mecanismo decide qué Intent puede plantearse en este turno:
 * Alert crítica → Alert (emisión) → Goal bloqueante → Goal reanudable → Opportunity.
 * El LLM nunca elige el Intent activo (D2 / D8).
 *
 * Checkout Goals nombrados NO entran acá mientras Ownership sea CHECKOUT
 * (ADR-0001): el ranker corre en el conversacional.
 */

import {
  getIntentCatalogEntry,
  saliencyRank,
  type IntentCandidate,
  type IntentType,
} from '../../domain/intent/family';
import {
  deriveOrderCompletionGoal,
  type OrderCompletionFacts,
  type OrderCompletionLedger,
} from '../orderCompletionGoal.service';
import {
  deriveReservationCompletionGoal,
  type ReservationCompletionFacts,
  type ReservationCompletionLedger,
} from '../reservationCompletionGoal.service';
import { nextReservationDraftQuestion } from '../../graph/nodes/session/buildResumeFollowUp';
import type { ReservationDraft } from '../../graph/nodes/session/buildResumeFollowUp';

/** Forma reutilizable del Ledger (ADR-0007). Campos específicos por tipo viven como extensión. */
export type IntentLedgerEntry = {
  abandonment?: boolean;
  surfaceCount?: number;
  lastSurfacedAt?: string | null;
  /** Alerts de cierre por emisión. */
  emitted?: boolean;
  /** Contador de rechazos (V-10) — Goals de captura. */
  refusalCount?: number;
  /** ISO del nacimiento / oferta (decay de Opportunities). */
  openedAt?: string | null;
  expiresAt?: string | null;
};

export type IntentLedgerView = Partial<Record<IntentType, IntentLedgerEntry>>;

export type IntentDerivationContext = {
  order: {
    facts: OrderCompletionFacts;
    ledger: OrderCompletionLedger;
  };
  reservation: {
    facts: ReservationCompletionFacts;
    ledger: ReservationCompletionLedger;
    draft?: ReservationDraft;
    hasEnvironments: boolean;
  };
  /** Candidatos adicionales ya derivados (Opportunities / Alerts de fases posteriores). */
  extras?: IntentCandidate[];
};

export type RankActiveIntentResult = {
  active: IntentCandidate | null;
  suppressed: IntentCandidate[];
  permission: { granted: boolean; reason: string };
  /** Métrica de guardia: 0 o 1. Si algún día llega 2, es bug P0. */
  intentsPlanteadosPorTurno: 0 | 1;
};

const ORDER_COMPLETION_HINT =
  '- Objetivo abierto (COMPLETAR_PEDIDO): el cliente tiene un pedido sin cerrar. ' +
  'Si es natural en este turno —después de responder lo que preguntó, y solo si tu ' +
  'respuesta no deja una pregunta abierta— podés ofrecerle continuar con el pedido o ' +
  'preguntarle si seguimos. No lo menciones si no viene al caso. Si el cliente pide ' +
  'explícitamente que no insistas más, usá la tool `abandon_pending_order` (no borra el carrito).';

export const buildOrderCompletionHint = (): string => ORDER_COMPLETION_HINT;

export const buildReservationCompletionHint = (
  draft: ReservationDraft | undefined,
  hasEnvironments: boolean
): string => {
  const missing = nextReservationDraftQuestion(draft, hasEnvironments);
  const missingLabel = missing ? ` (falta: ${missing})` : '';
  return (
    '- Objetivo abierto (COMPLETAR_RESERVA): el cliente tiene una reserva sin terminar' +
    `${missingLabel}. Si es natural en este turno —después de responder lo que preguntó, ` +
    'y solo si tu respuesta no deja una pregunta abierta— podés ofrecerle continuar con la ' +
    'reserva. No lo menciones si no viene al caso. Si el cliente pide explícitamente que no ' +
    'insistas más, usá la tool `abandon_pending_reservation` (no borra el borrador).'
  );
};

/**
 * Compone los derivadores de dominio existentes. No los reescribe.
 * Emite un IntentCandidate solo si el Goal está abierto.
 */
export const deriveIntentCandidates = (ctx: IntentDerivationContext): IntentCandidate[] => {
  const candidates: IntentCandidate[] = [];

  const orderGoal = deriveOrderCompletionGoal(ctx.order.facts, ctx.order.ledger);
  if (orderGoal.open) {
    const cat = getIntentCatalogEntry('COMPLETAR_PEDIDO');
    candidates.push({
      type: 'COMPLETAR_PEDIDO',
      kind: cat.kind,
      pressure: cat.pressure,
      closeMode: cat.closeMode,
      hint: buildOrderCompletionHint(),
      // Empate entre Goals reanudables: pedido gana a reserva (pago pendiente > futuro).
      tieBreak: 100,
    });
  }

  const reservationGoal = deriveReservationCompletionGoal(
    ctx.reservation.facts,
    ctx.reservation.ledger
  );
  if (reservationGoal.open) {
    const cat = getIntentCatalogEntry('COMPLETAR_RESERVA');
    candidates.push({
      type: 'COMPLETAR_RESERVA',
      kind: cat.kind,
      pressure: cat.pressure,
      closeMode: cat.closeMode,
      hint: buildReservationCompletionHint(
        ctx.reservation.draft,
        ctx.reservation.hasEnvironments
      ),
      tieBreak: 50,
    });
  }

  if (ctx.extras?.length) {
    candidates.push(...ctx.extras);
  }

  return candidates;
};

const entryFor = (ledger: IntentLedgerView, type: IntentType): IntentLedgerEntry =>
  ledger[type] ?? {};

export type PermissionDenialReason =
  | 'budget_exhausted'
  | 'cooldown'
  | 'emitted'
  | 'expired'
  | 'ok';

/** Presupuesto unificado según catálogo (D2 / D7). */
export const computeCatalogPermission = (
  type: IntentType,
  entry: IntentLedgerEntry,
  now: number = Date.now()
): { granted: boolean; reason: PermissionDenialReason } => {
  const cat = getIntentCatalogEntry(type);

  // Alerts de cierre por emisión: una vez emitidas, no vuelven.
  if (entry.emitted && cat.closeMode === 'emission') {
    return { granted: false, reason: 'emitted' };
  }

  // emission_then_fact: el Fact cierra (el derivador deja de emitir).
  // `emitted` / surfaceCount no bastan para cerrar — solo limitan el ruido
  // vía cooldown, para que siga bloqueando Opportunities mientras el Fact viva.
  if (cat.closeMode !== 'emission_then_fact' && (entry.surfaceCount ?? 0) >= cat.maxSurfaces) {
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

const compareCandidates = (a: IntentCandidate, b: IntentCandidate): number => {
  const rankDiff = saliencyRank(a) - saliencyRank(b);
  if (rankDiff !== 0) return rankDiff;
  return b.tieBreak - a.tieBreak;
};

/**
 * Elige un solo Intent activo (ADR-0009). Nunca el LLM.
 * Log obligatorio: `[intent] active_rank`.
 */
export const rankActiveIntent = (
  candidates: IntentCandidate[],
  ledger: IntentLedgerView,
  opts: { now?: number; conversationId?: string } = {}
): RankActiveIntentResult => {
  const now = opts.now ?? Date.now();

  if (candidates.length === 0) {
    const empty: RankActiveIntentResult = {
      active: null,
      suppressed: [],
      permission: { granted: false, reason: 'no_candidates' },
      intentsPlanteadosPorTurno: 0,
    };
    console.log(
      JSON.stringify({
        event: '[intent] active_rank',
        conversationId: opts.conversationId ?? null,
        active: null,
        suppressed: [],
        reason: 'no_candidates',
        intents_planteados_por_turno: 0,
      })
    );
    return empty;
  }

  const eligible: IntentCandidate[] = [];
  const denied: Array<{ candidate: IntentCandidate; reason: string }> = [];

  for (const c of candidates) {
    const perm = computeCatalogPermission(c.type, entryFor(ledger, c.type), now);
    if (perm.granted) {
      eligible.push(c);
    } else {
      denied.push({ candidate: c, reason: perm.reason });
    }
  }

  if (eligible.length === 0) {
    const reason = denied[0]?.reason ?? 'all_denied';
    console.log(
      JSON.stringify({
        event: '[intent] active_rank',
        conversationId: opts.conversationId ?? null,
        active: null,
        suppressed: candidates.map((c) => c.type),
        reason,
        denials: denied.map((d) => ({ type: d.candidate.type, reason: d.reason })),
        intents_planteados_por_turno: 0,
      })
    );
    return {
      active: null,
      suppressed: candidates,
      permission: { granted: false, reason },
      intentsPlanteadosPorTurno: 0,
    };
  }

  const sorted = [...eligible].sort(compareCandidates);
  const active = sorted[0]!;
  const suppressed = [
    ...sorted.slice(1),
    ...denied.map((d) => d.candidate),
  ];

  console.log(
    JSON.stringify({
      event: '[intent] active_rank',
      conversationId: opts.conversationId ?? null,
      active: active.type,
      suppressed: suppressed.map((c) => c.type),
      reason: 'granted',
      intents_planteados_por_turno: 1,
    })
  );

  return {
    active,
    suppressed,
    permission: { granted: true, reason: 'granted' },
    intentsPlanteadosPorTurno: 1,
  };
};

/** Construye la vista de Ledger desde las entradas tipadas conocidas. */
export const buildIntentLedgerView = (parts: {
  order?: OrderCompletionLedger;
  reservation?: ReservationCompletionLedger;
  extras?: IntentLedgerView;
}): IntentLedgerView => {
  const view: IntentLedgerView = { ...(parts.extras ?? {}) };
  if (parts.order) {
    view.COMPLETAR_PEDIDO = {
      abandonment: parts.order.abandonment,
      surfaceCount: parts.order.surfaceCount,
      lastSurfacedAt: parts.order.lastSurfacedAt,
    };
  }
  if (parts.reservation) {
    view.COMPLETAR_RESERVA = {
      abandonment: parts.reservation.abandonment,
      surfaceCount: parts.reservation.surfaceCount,
      lastSurfacedAt: parts.reservation.lastSurfacedAt,
    };
  }
  return view;
};
