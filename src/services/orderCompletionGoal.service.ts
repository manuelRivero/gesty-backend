/**
 * COMPLETAR_PEDIDO — primer Goal derivado del sistema (Fase 0 del roadmap de
 * migración, ver docs/arquitectura/ROADMAP-MIGRACION.md).
 *
 * Proyección pura sobre Facts (ítems en el carrito, sesión de checkout):
 * nunca se persiste (ADR-0005) — se recalcula en cada turno, no se "crea" ni
 * se "cierra". El Ledger (abandonment + surface_count) sí se persiste, por
 * fuera del Goal, porque es memoria del comportamiento del sistema, no del
 * negocio (ADR-0007) — es lo único que le permite al Goal seguir siendo puro
 * sin que el sistema pierda la cuenta de cuántas veces ya insistió.
 */

import { patchIntentLedgerEntry } from './intentLedger.repository';
import type { ConversationMetadata } from './productQuery/types';
import { normalizeMetadata } from './productQuery/utils';

export interface OrderCompletionFacts {
  hasItems: boolean;
  checkoutActive: boolean;
  /**
   * Cola de líneas de pedido abierta (D7 de PLAN-ACCION-PEDIDO-MULTI-LINEA.md):
   * el cliente todavía tiene platos por resolver de un mismo mensaje — no es
   * momento de plantear "cerramos el pedido".
   */
  hasOpenOrderLines?: boolean;
}

export interface OrderCompletionLedger {
  abandonment: boolean;
  surfaceCount: number;
  lastSurfacedAt: string | null;
}

const EMPTY_LEDGER: OrderCompletionLedger = {
  abandonment: false,
  surfaceCount: 0,
  lastSurfacedAt: null,
};

export const getOrderCompletionLedger = (metadata: unknown): OrderCompletionLedger => {
  const meta: ConversationMetadata = normalizeMetadata(metadata);
  return { ...EMPTY_LEDGER, ...(meta.intentLedger?.COMPLETAR_PEDIDO ?? {}) };
};

export interface OrderCompletionGoal {
  /** Abierto ⟺ hay ítems, no arrancó el checkout y no fue abandonado. */
  open: boolean;
}

/** Derivador puro (ADR-0005, ADR-0006): sin estado propio, recalculado cada turno. */
export const deriveOrderCompletionGoal = (
  facts: OrderCompletionFacts,
  ledger: OrderCompletionLedger
): OrderCompletionGoal => ({
  open:
    facts.hasItems &&
    !facts.checkoutActive &&
    !facts.hasOpenOrderLines &&
    !ledger.abandonment,
});

/** Presupuesto de insistencia (ADR-0008): 3 → enmudece, no muere. */
export const ORDER_COMPLETION_SURFACE_BUDGET = 3;

/** Cooldown entre planteos consecutivos del mismo Goal. */
export const ORDER_COMPLETION_COOLDOWN_MS = 10 * 60 * 1000;

export type OrderCompletionPermissionReason =
  | 'granted'
  | 'closed'
  | 'budget_exhausted'
  | 'cooldown'
  | 'suppressed_by_saliency';

export interface OrderCompletionPermission {
  granted: boolean;
  reason: OrderCompletionPermissionReason;
}

/**
 * Permiso que calcula el sistema (ADR-0009, ADR-0010): el modelo nunca
 * decide si el Goal puede plantearse, solo si este turno es el momento.
 */
export const computeOrderCompletionPermission = (
  goal: OrderCompletionGoal,
  ledger: OrderCompletionLedger,
  now: number = Date.now()
): OrderCompletionPermission => {
  if (!goal.open) return { granted: false, reason: 'closed' };
  if (ledger.surfaceCount >= ORDER_COMPLETION_SURFACE_BUDGET) {
    return { granted: false, reason: 'budget_exhausted' };
  }
  if (
    ledger.lastSurfacedAt &&
    now - new Date(ledger.lastSurfacedAt).getTime() < ORDER_COMPLETION_COOLDOWN_MS
  ) {
    return { granted: false, reason: 'cooldown' };
  }
  return { granted: true, reason: 'granted' };
};

const patchLedger = (conversationId: string, ledger: OrderCompletionLedger): Promise<void> =>
  patchIntentLedgerEntry(conversationId, 'COMPLETAR_PEDIDO', ledger);

/** Registra que el Goal se planteó este turno (consume presupuesto de insistencia). */
export const recordOrderCompletionSurfaced = async (
  conversationId: string,
  ledger: OrderCompletionLedger
): Promise<void> => {
  await patchLedger(conversationId, {
    ...ledger,
    surfaceCount: ledger.surfaceCount + 1,
    lastSurfacedAt: new Date().toISOString(),
  });
};

/**
 * El cliente pidió explícitamente que no insistamos (ADR-0005, caso 1: "el
 * único bit que separa un asistente de un acosador"). NO borra el carrito.
 */
export const recordOrderCompletionAbandonment = async (
  conversationId: string,
  ledger: OrderCompletionLedger
): Promise<void> => {
  await patchLedger(conversationId, { ...ledger, abandonment: true });
};

/**
 * Revival (ADR-0005, corolario obligatorio): si el cliente había abandonado
 * el pedido y agrega otro ítem, el abandono se limpia solo — sin esto,
 * `abandonment = true` es una lápida que el bot nunca vuelve a ayudar a cerrar.
 */
export const reviveOrderCompletionIfAbandoned = async (
  conversationId: string,
  ledger: OrderCompletionLedger
): Promise<void> => {
  if (!ledger.abandonment && ledger.surfaceCount === 0) return;
  await patchLedger(conversationId, EMPTY_LEDGER);
};

/**
 * Cierra la "vida" del Ledger cuando el pedido deja de existir (carrito
 * vacío): un pedido nuevo más adelante empieza con presupuesto fresco.
 */
export const resetOrderCompletionLedgerIfCartEmpty = async (
  conversationId: string,
  facts: OrderCompletionFacts,
  ledger: OrderCompletionLedger
): Promise<void> => {
  if (facts.hasItems) return;
  if (ledger.surfaceCount === 0 && !ledger.abandonment) return;
  await patchLedger(conversationId, EMPTY_LEDGER);
};

/**
 * Líneas para inyectar en `[ESTADO DEL CLIENTE]` del hybrid agent + logging
 * obligatorio del Ledger (ADR-0007: "surfaced_intent es obligatorio y no
 * negociable"). Efecto secundario intencional: si el sistema otorga permiso,
 * consume presupuesto acá — es el único punto del turno donde se sabe que el
 * Goal fue puesto en la función objetivo del modelo.
 */
export const buildOrderCompletionContextLines = (params: {
  facts: OrderCompletionFacts;
  ledger: OrderCompletionLedger;
  conversationId: string;
  /** ADR-0009: a lo sumo un Intent activo por turno — lo decide el arbitraje del caller. */
  suppressedBySaliency?: boolean;
}): string[] => {
  const { facts, ledger, conversationId, suppressedBySaliency } = params;
  const goal = deriveOrderCompletionGoal(facts, ledger);
  const rawPermission = computeOrderCompletionPermission(goal, ledger);
  const permission: OrderCompletionPermission =
    suppressedBySaliency && rawPermission.granted
      ? { granted: false, reason: 'suppressed_by_saliency' }
      : rawPermission;

  console.log(
    JSON.stringify({
      event: '[goal] order_completion_ledger',
      conversationId,
      open: goal.open,
      permission: permission.reason,
      surfaceCount: ledger.surfaceCount,
      abandonment: ledger.abandonment,
    })
  );

  void resetOrderCompletionLedgerIfCartEmpty(conversationId, facts, ledger).catch((err) =>
    console.error('[goal] failed to reset order completion ledger:', err)
  );

  if (!permission.granted) return [];

  void recordOrderCompletionSurfaced(conversationId, ledger).catch((err) =>
    console.error('[goal] failed to record order completion surfaced:', err)
  );

  return [
    '- Objetivo abierto (COMPLETAR_PEDIDO): el cliente tiene un pedido sin cerrar. ' +
      'Si es natural en este turno —después de responder lo que preguntó, y solo si tu ' +
      'respuesta no deja una pregunta abierta— podés ofrecerle continuar con el pedido o ' +
      'preguntarle si seguimos. No lo menciones si no viene al caso. ' +
      'Si el cliente quiere cancelar / borrar el pedido, eso es cancelación real (intent CANCEL_ORDER), ' +
      'no un silencio del Goal.',
  ];
};
