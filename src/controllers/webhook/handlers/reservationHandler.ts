import { EnrichedContext, HandlerResult, IntentHandler } from '../types';
import { interactiveResponse, noResponse, textResponse } from '../utils';
import { ConversationIntent } from '../../../types/conversationIntent';
import { handleReservationIntent } from '../../../services/reservations';

/**
 * @deprecated Handler del dispatcher clásico para el wizard legacy de
 * reservas. Con `RESERVATION_AGENT_ENABLED=true`, el intent `RESERVATION`
 * nunca llega hasta acá para conversaciones nuevas (se intercepta antes en
 * `dispatch/index.ts`/`context/index.ts` y arranca el agente). Este handler
 * solo se ejecuta si el flag está apagado (fallback/kill-switch) o para
 * completar una sesión de wizard ya en curso. Ver `reservation.service.ts`.
 */
export class ReservationHandler implements IntentHandler {
  readonly command = ConversationIntent.RESERVATION;

  canHandle(intent: string): boolean {
    return intent === this.command;
  }

  async execute(ctx: EnrichedContext): Promise<HandlerResult | null> {
    const result = await handleReservationIntent(ctx);
    if (result === null) return noResponse();
    if (
      typeof result === "object" &&
      result !== null &&
      "content" in result &&
      typeof result.isInteractive === "boolean"
    ) {
      return result as HandlerResult;
    }
    if (typeof result === 'string') return textResponse(result);
    return interactiveResponse(result);
  }
}
