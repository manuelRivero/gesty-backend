/**
 * Mapa de dominio en turno frío (BOT-07).
 *
 * Facts de sesión y de capacidades del local. No nombra tools ni invita a
 * desambiguar en voz alta. Si la capacidad no llegó al contexto, no hay mapa.
 */

import type { CapabilityAccessResult } from '../services/evaluateBusinessCapabilityAccess.service';
import type { ConversationMetadata } from '../services/productQuery/types';
import { isReservationFaqMode } from '../services/reservationFaqDelegation.service';
import { hasReservationDraftInProgress } from '../services/reservationCompletionGoal.service';

const DRAFT_SESSION_LINE =
  '- Sesión: ninguna abierta. Hay una reserva en borrador sin sesión (no la retomes por tu cuenta).';

/** Turno sin dueño de dominio. El draft de reserva no cuenta como sesión. */
export const isStructurallyColdDomainTurn = (
  metadata: ConversationMetadata,
  hasCartItems: boolean
): boolean => {
  if (hasCartItems) return false;
  if (metadata.checkout_active === true) return false;
  if (isReservationFaqMode(metadata)) return false;
  if (metadata.onboarding_agent_active === true) return false;
  if (metadata.onboarding_step != null && String(metadata.onboarding_step).length > 0) {
    return false;
  }
  return true;
};

const sessionLine = (
  mode: CapabilityAccessResult['mode'],
  hasDraft: boolean
): string | null => {
  if (mode === 'orders_only') {
    return '- Sesión: ninguna abierta (sin pedido en armado, sin checkout).';
  }
  if (hasDraft) return DRAFT_SESSION_LINE;
  if (mode === 'reservations_only') return '- Sesión: ninguna abierta.';
  if (mode === 'full') {
    return '- Sesión: ninguna abierta (sin pedido en armado, sin reserva, sin checkout).';
  }
  return null;
};

const takesLine = (mode: CapabilityAccessResult['mode']): string | null => {
  if (mode === 'full') return '- El local toma: pedidos y reservas de mesa.';
  if (mode === 'reservations_only') {
    return '- El local toma: solo reservas de mesa. NO toma pedidos por este chat.';
  }
  if (mode === 'orders_only') return '- El local toma: pedidos.';
  return null;
};

/**
 * Dos líneas como máximo. `blocked`, capacidad ausente o turno con dueño → [].
 */
export const buildDomainStateContextLines = (params: {
  metadata: ConversationMetadata;
  hasCartItems: boolean;
  capability: CapabilityAccessResult | null | undefined;
}): string[] => {
  if (!isStructurallyColdDomainTurn(params.metadata, params.hasCartItems)) return [];
  const capability = params.capability;
  if (!capability || capability.mode === 'blocked') return [];

  const hasDraft = hasReservationDraftInProgress(params.metadata.reservation_draft);
  const session = sessionLine(capability.mode, hasDraft);
  const takes = takesLine(capability.mode);
  if (!session || !takes) return [];
  return [session, takes];
};
