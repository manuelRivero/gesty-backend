/**
 * Helper puro compartido por los nodos de sesión (checkout, reservas,
 * onboarding) para re-formular la pregunta suspendida tras un turno
 * delegado (`delegate_to_main`, H-03).
 *
 * La respuesta del híbrido a una consulta lateral ("¿hasta qué hora
 * abren?") reemplazaba antes por completo el turno: el usuario recibía
 * la respuesta lateral y debía adivinar que el pedido/reserva/dirección
 * seguía en curso. Este helper deriva, a partir del estado real (no del
 * texto del LLM), el follow-up a anexar después de la respuesta lateral.
 */

import { nextReservationStep } from '../../../services/reservations/nextReservationStep';

export type CheckoutPendingAction = 'fulfillment_type' | 'payment_method' | 'confirm_order';

export interface ReservationDraft {
  date?: string;
  slotId?: string;
  time?: string;
  endTime?: string;
  partySize?: number;
  environmentId?: string | null;
}

export type OnboardingResumeStep = 'capture' | 'confirm' | 'name' | 'done';

export type ResumeFollowUpInput =
  | {
      kind: 'checkout';
      pendingAction: CheckoutPendingAction | null | undefined;
      pendingQuestion: string | null | undefined;
    }
  | {
      kind: 'reservation';
      draft: ReservationDraft | undefined;
      hasEnvironments: boolean;
      /**
       * Tras FAQ mid-reserva: solo D3 (seguir o cancelar). No anexa fecha/slot.
       */
      includeContinueOrCancel?: boolean;
    }
  | {
      kind: 'onboarding';
      /** Paso derivado por `nextOnboardingStep` — única fuente de verdad (D3). */
      step: OnboardingResumeStep;
      /** Dirección staged (`temp_address`) cuando `step === 'confirm'`. */
      stagedAddress: string | null;
    };

export interface ResumeFollowUp {
  /** `null` cuando no hay nada pendiente que retomar (no anexar nada al turno). */
  text: string | null;
  /** Solo para checkout: qué botones re-adjuntar junto al texto. */
  checkoutPendingAction?: CheckoutPendingAction;
  /** Solo para onboarding en paso `confirm`: dirección a re-adjuntar con botones Confirmar/Editar. */
  onboardingStagedAddress?: string;
}

const RESUME_PREFIX = {
  checkout: 'Volviendo a tu pedido:',
  reservation: 'Seguimos con tu reserva:',
  onboarding: 'Seguimos:',
} as const;

/** Copy fijo post-FAQ mid-reserva (D3) — no depende del LLM. */
export const RESERVATION_FAQ_CONTINUE_OR_CANCEL =
  '¿Seguimos con la reserva o preferís cancelarla?';

/**
 * Anexa el follow-up salvo que el texto del agente ya lo traiga: el modelo a
 * veces copia la pregunta de cierre y el mensaje salía con ella dos veces
 * (e2e 22/9, FAQ de platos mid-reserva).
 */
export function appendResumeFollowUp(
  content: string,
  followUp: string
): string {
  const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return normalize(content).includes(normalize(followUp))
    ? content
    : `${content}\n\n${followUp}`;
}

/**
 * Exportada para reuso en `reservationCompletionGoal.service.ts` (Fase 1b): es la
 * misma fuente de verdad de qué falta en el borrador, tanto para retomar tras
 * una interrupción como para saber si el Goal `COMPLETAR_RESERVA` sigue abierto.
 */
export function nextReservationDraftQuestion(
  draft: ReservationDraft | undefined,
  hasEnvironments: boolean
): string | null {
  // Deriva de nextReservationStep (D5) — única fuente de verdad del orden.
  const step = nextReservationStep(
    {
      date: draft?.date,
      slotId: draft?.slotId,
      partySize: draft?.partySize,
      environmentId: draft?.environmentId,
    },
    { hasEnvironments }
  );
  switch (step) {
    case 'date':
      return '¿para qué día querés reservar?';
    case 'slot':
      return '¿en qué horario?';
    case 'party_size':
      return '¿para cuántas personas?';
    case 'environment':
      return '¿preferís algún ambiente en particular?';
    case 'confirm':
    case 'done':
      return null;
  }
}

export function buildResumeFollowUp(input: ResumeFollowUpInput): ResumeFollowUp {
  switch (input.kind) {
    case 'checkout': {
      if (!input.pendingAction || !input.pendingQuestion) {
        return { text: null };
      }
      return {
        text: `${RESUME_PREFIX.checkout} ${input.pendingQuestion}`,
        checkoutPendingAction: input.pendingAction,
      };
    }
    case 'reservation': {
      // FAQ (D3): una sola pregunta seguir/cancelar. No anexar fecha/horario —
      // eso lo pide el agente de reservas en el turno siguiente (lista de slots).
      if (input.includeContinueOrCancel) {
        return { text: RESERVATION_FAQ_CONTINUE_OR_CANCEL };
      }
      const question = nextReservationDraftQuestion(input.draft, input.hasEnvironments);
      if (!question) return { text: null };
      return { text: `${RESUME_PREFIX.reservation} ${question}` };
    }
    case 'onboarding': {
      if (input.step === 'done') return { text: null };
      if (input.step === 'confirm' && input.stagedAddress) {
        return {
          text: `${RESUME_PREFIX.onboarding} ¿es correcta esta dirección?\n${input.stagedAddress}`,
          onboardingStagedAddress: input.stagedAddress,
        };
      }
      if (input.step === 'name') {
        return {
          text: '¿Con qué nombre te gustaría que te agende?',
        };
      }
      return {
        text:
          `${RESUME_PREFIX.onboarding} si querés hacer un pedido con delivery, ` +
          `necesito tu dirección para validar la zona de entrega. ` +
          `Si solo querés ver el menú, reservar o consultar, podés omitirla por ahora ` +
          `(después la podés agregar o cambiar). Decime tu dirección o compartí tu ubicación 📍`,
      };
    }
  }
}
