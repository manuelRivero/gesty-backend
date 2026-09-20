/**
 * Fact efímero `reservation_faq_delegation` (PLAN-ACCION-RESERVA-FAQ-HIBRIDO).
 *
 * Se setea al entrar en `delegate_to_main` desde el nodo de reservas y se
 * limpia al salir del mismo turno. Ownership/contexto de turno — no es Goal.
 */

import type { IntentType } from '../domain/intent/family';
import type { ConversationMetadata } from './productQuery/types';
import { normalizeMetadata } from './productQuery/utils';

export const RESERVATION_FAQ_DELEGATION_KEY = 'reservation_faq_delegation' as const;

export type ReservationFaqDelegation = {
  reason?: string;
  delegatedAt: string;
};

/** Goals/Opportunities de pedido que no deben empujar durante FAQ mid-reserva. */
export const ORDER_PUSH_INTENTS_DURING_RESERVATION_FAQ = new Set<IntentType>([
  'COMPLETAR_PEDIDO',
  'OBTENER_PERSONAS_DEL_PEDIDO',
  'CONFIRMAR_OFERTA',
  'SUGERIR_COMPLEMENTO',
  'OFRECER_PROMOCION',
]);

export const buildReservationFaqDelegation = (
  reason?: string | null
): ReservationFaqDelegation => ({
  ...(reason?.trim() ? { reason: reason.trim() } : {}),
  delegatedAt: new Date().toISOString(),
});

export const getReservationFaqDelegation = (
  metadata: unknown
): ReservationFaqDelegation | null => {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  const raw = meta.reservation_faq_delegation;
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.delegatedAt !== 'string' || !raw.delegatedAt) return null;
  return {
    delegatedAt: raw.delegatedAt,
    ...(typeof raw.reason === 'string' && raw.reason.trim()
      ? { reason: raw.reason.trim() }
      : {}),
  };
};

/**
 * Modo FAQ mid-reserva: Fact D1 o sesión de reserva activa (el híbrido solo
 * corre vía delegate_to_main mientras la sesión vive).
 */
export const isReservationFaqMode = (metadata: unknown): boolean => {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  if (getReservationFaqDelegation(meta)) return true;
  return meta.reservation_agent_active === true;
};

export const buildReservationFaqDelegationContextLines = (
  metadata: unknown
): string[] => {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  const faq = getReservationFaqDelegation(meta);
  if (!faq && meta.reservation_agent_active !== true) return [];

  const reasonSuffix = faq?.reason ? ` (razón: ${faq.reason})` : '';
  const lines = [
    `- Delegación FAQ mid-reserva: activa${reasonSuffix}`,
  ];

  const party = meta.reservation_draft?.partySize;
  if (typeof party === 'number' && party >= 1) {
    lines.push(
      `- Mesa en borrador: ${party} personas (contexto de la reserva — NO son personas del pedido; no pidas party size de pedido, no armes carrito, no ofrezcas sumar platos al pedido en prosa)`
    );
  } else {
    lines.push(
      '- Mesa en borrador: sin party size aún (NO pidas personas del pedido, no armes carrito, no ofrezcas sumar platos al pedido en prosa)'
    );
  }

  return lines;
};
