import { z } from 'zod';
import { SystemMessage, HumanMessage } from '@langchain/core/messages';
import { getIntentDetectorLlm } from '../../config/llm';
import {
  RESERVATION_TURN_SYSTEM_PROMPT,
  buildReservationTurnUserPrompt,
  type ReservationTurnInput,
} from '../../prompts/reservationTurnClassifier';
import { wantsReservationManagement } from './reservationIntentText';

export const ReservationTurnSchema = z.object({
  action: z.enum(['FULFILL_STEP', 'DELEGATE']),
  confidence: z.number().min(0).max(1),
  reason: z.string().nullable(),
});

export type ReservationTurnClassification = z.infer<typeof ReservationTurnSchema> & {
  source: 'deterministic' | 'llm' | 'fallback';
};

const DATE_REGEX = /^\d{1,2}\/\d{1,2}(\/\d{4})?$/;
const INT_1_99 = /^\d{1,2}$/;

/** True si el payload es del propio wizard (botones/listas de reserva). */
const isReservationPayload = (p?: string): boolean =>
  !!p && p.startsWith('RESERVATION_');

/**
 * Decide FULFILL_STEP vs DELEGATE por turno del wizard.
 * Atajos determinísticos primero; LLM solo si no hay regla aplicable.
 */
export async function classifyReservationTurn(
  input: ReservationTurnInput
): Promise<ReservationTurnClassification> {
  const { step, userMessage, payloadId } = input;
  const text = (userMessage ?? '').trim();

  // 1) Payloads del wizard → FULFILL
  if (isReservationPayload(payloadId)) {
    return { action: 'FULFILL_STEP', confidence: 1, reason: 'reservation_payload', source: 'deterministic' };
  }
  // 2) Payload NO-reserva (botón ajeno) → DELEGATE
  if (payloadId) {
    return { action: 'DELEGATE', confidence: 1, reason: 'foreign_payload', source: 'deterministic' };
  }
  // 3) Texto de gestión de reserva (cancelar/reiniciar/gestionar) → FULFILL (evita resume espurio)
  if (text && wantsReservationManagement(text)) {
    return { action: 'FULFILL_STEP', confidence: 0.9, reason: 'reservation_management_text', source: 'deterministic' };
  }
  // 4) Reprompt: sin texto y sin payload → FULFILL
  if (!text) {
    return { action: 'FULFILL_STEP', confidence: 0.8, reason: 'empty_reprompt', source: 'deterministic' };
  }
  // 5) Validadores por step que no requieren LLM
  if (step === 'ASK_DATE' && DATE_REGEX.test(text)) {
    return { action: 'FULFILL_STEP', confidence: 0.95, reason: 'date_format', source: 'deterministic' };
  }
  if (step === 'ASK_PARTY_SIZE' && INT_1_99.test(text)) {
    return { action: 'FULFILL_STEP', confidence: 0.95, reason: 'party_size_number', source: 'deterministic' };
  }

  // 6) LLM para el resto (texto ambiguo, off-topic, nombre vs pregunta, etc.)
  try {
    const llm = getIntentDetectorLlm().withStructuredOutput(ReservationTurnSchema);
    const parsed = await llm.invoke([
      new SystemMessage(RESERVATION_TURN_SYSTEM_PROMPT),
      new HumanMessage(buildReservationTurnUserPrompt(input)),
    ]);
    return { ...parsed, source: 'llm' };
  } catch (error) {
    console.error('[reservation-turn] LLM error, fallback FULFILL_STEP:', error);
    return { action: 'FULFILL_STEP', confidence: 0, reason: 'llm_error', source: 'fallback' };
  }
}
