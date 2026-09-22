/**
 * FAQ de platos para la mesa: sin Fact de personas no hay delegate_to_main.
 * El reason "sugerir platos para 1" no es un Fact (log 21/9: N inventado).
 */

import { formatBotUserMessage } from '../productQuery/utils';

export const ASK_RESERVATION_PARTY_SIZE_FOR_DISHES = formatBotUserMessage(
  '¿Para cuántas personas?',
  '👥',
  'Para recomendarte platos que sirvan para la mesa, necesito saber cuántas personas van a asistir.'
);

export const isDishSuggestionDelegationReason = (
  reason?: string | null
): boolean => {
  const r = (reason ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '');
  if (!r.trim()) return false;
  return (
    /sugerir platos/.test(r) ||
    /platos para/.test(r) ||
    /por raciones/.test(r) ||
    /que platos/.test(r) ||
    /menu para la (mesa|reserva)/.test(r)
  );
};

export const hasSavedReservationPartySize = (
  partySize: number | null | undefined
): boolean => typeof partySize === 'number' && Number.isInteger(partySize) && partySize >= 1;

/** Bloquea FAQ de platos si el reason es menú-para-mesa y no hay partySize en el draft. */
export const shouldBlockDishFaqWithoutPartySize = (params: {
  delegateToMain: boolean;
  reason?: string | null;
  partySize?: number | null;
}): boolean => {
  if (!params.delegateToMain) return false;
  if (!isDishSuggestionDelegationReason(params.reason)) return false;
  return !hasSavedReservationPartySize(params.partySize);
};
