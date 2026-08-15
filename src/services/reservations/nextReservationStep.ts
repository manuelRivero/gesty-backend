/**
 * Fuente de verdad determinística del orden de recolección de reservas
 * (P1.1, D5). Antes de esto el orden vivía duplicado en el prompt
 * (`buildReservationAgentSystemPrompt`) y en `nextReservationDraftQuestion`
 * (`buildResumeFollowUp.ts`), desalineados en qué Fact representa el
 * horario (`time` vs `slotId`). Mismo patrón que `nextCheckoutStep.ts` y
 * `nextOnboardingStep.ts`.
 *
 * El Fact de horario es `slotId` — es lo que valida el nodo al confirmar
 * (`RESERVATION_CONFIRM` busca el slot por id). `time`/`endTime` son
 * derivados para mostrar, no la fuente de verdad.
 */

export type ReservationStep =
  | 'date'
  | 'slot'
  | 'party_size'
  | 'environment'
  | 'confirm'
  | 'done';

export interface ReservationStepState {
  date: string | null | undefined;
  slotId: string | null | undefined;
  partySize: number | null | undefined;
  /** `undefined` = no elegido todavía; `null` = "sin preferencia" (Fact explícito). */
  environmentId: string | null | undefined;
}

export interface ReservationStepConfig {
  hasEnvironments: boolean;
}

/**
 * `done` no lo devuelve esta función: una vez en `confirm` no hay más datos
 * que recolectar del draft. Se reserva para el estado posterior a la
 * creación de la reserva (sesión ya cerrada), que no se modela con este
 * draft — lo maneja el nodo al limpiar `reservation_agent_active`.
 */
export function nextReservationStep(
  state: ReservationStepState,
  config: ReservationStepConfig
): ReservationStep {
  if (!state.date) return 'date';
  if (!state.slotId) return 'slot';
  if (state.partySize == null) return 'party_size';
  if (config.hasEnvironments && state.environmentId === undefined) return 'environment';
  return 'confirm';
}

export const expectedActionForReservationStep = (step: ReservationStep): string => {
  switch (step) {
    case 'date':
      return 'pedir fecha en prosa; resolve_date + save_reservation_date cuando la indique';
    case 'slot':
      return 'get_available_slots(date) para mostrar horarios';
    case 'party_size':
      return 'pedir cantidad de personas; save_reservation_party_size cuando la indique';
    case 'environment':
      return 'aceptar ambiente en prosa o lista; save_reservation_environment(id|null) / tipable select_environment';
    case 'confirm':
      return 'present_confirmation() (tipable confirm_reservation o resolve_reservation_confirmation en texto)';
    case 'done':
      return 'ninguna';
  }
};
