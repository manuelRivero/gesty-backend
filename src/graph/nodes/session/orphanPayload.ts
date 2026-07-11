/**
 * Payloads interactivos "huérfanos" dentro de una sesión (H-09): el usuario
 * toca un botón/lista viejo (de un CTA o mensaje anterior) que el nodo de
 * sesión (checkout/reservas) no reconoce entre sus payloads manejados. Como
 * los mensajes interactivos no traen `message.text.body`, el agente LLM
 * recibía el turno con el mensaje del usuario vacío y respondía a ciegas,
 * perdiendo la acción.
 *
 * Este helper sintetiza un texto describiendo la acción tocada (a partir del
 * título del botón/lista si está disponible, o del payloadId crudo) para que
 * el agente tenga contexto real en vez de un mensaje vacío.
 */

import type { EnrichedContext } from '../../../controllers/webhook/types';

export function describeOrphanInteractivePayload(ctx: EnrichedContext): string | null {
  const payloadId = ctx.payloadId;
  if (!payloadId) return null;
  if (ctx.message?.type !== 'interactive') return null;

  const title: string | undefined =
    ctx.message?.interactive?.button_reply?.title ??
    ctx.message?.interactive?.list_reply?.title;

  return title
    ? `[el cliente tocó: "${title}"]`
    : `[el cliente tocó un botón/lista de un mensaje anterior: ${payloadId}]`;
}

/**
 * Devuelve un `EnrichedContext` con `message.text.body` sintetizado a partir
 * del payload huérfano, para pasarle contexto real al agente. No muta `ctx`.
 */
export function withOrphanPayloadAsText(ctx: EnrichedContext): EnrichedContext {
  const synthetic = describeOrphanInteractivePayload(ctx);
  if (!synthetic) return ctx;
  return {
    ...ctx,
    message: { ...ctx.message, text: { body: synthetic } },
  };
}
