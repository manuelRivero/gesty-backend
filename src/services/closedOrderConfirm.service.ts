/**
 * Confirmación tipable de pedido con negocio cerrado.
 *
 * Botón (CONFIRM_CLOSED_ORDER / CANCEL_CLOSED_ORDER) y prosa tipable
 * (`extractPendingTurnResponse`) comparten el mismo efecto en el borde —
 * agent-factory §3.11 / hybrid-pending-autonomy.
 */

import { z } from 'zod';
import { dispatchInteractive } from '../controllers/webhook/dispachers';
import type { EnrichedContext, HandlerResult } from '../controllers/webhook/types';
import { patchConversationMetadata, omitConversationMetadataKeys } from '../repositories';
import { CLOSED_ORDER_CANCELLED_BOT_MESSAGE } from './productQuery/botMessages';
import { extractPendingTurnResponse } from './ai/extractPendingTurnResponse';

export const ConfirmClosedOrderPendingSchema = z.object({ confirmed: z.boolean() });
export type ConfirmClosedOrderPendingValue = z.infer<typeof ConfirmClosedOrderPendingSchema>;

export const CONFIRM_CLOSED_ORDER_QUESTION =
  '¿Querés que registremos tu pedido de todas formas?';

export const CONFIRM_CLOSED_ORDER_VALUE_HINTS = `{
  "confirmed": true | false
}
- true: sí, dale, confirmo, ok, adelante, listo, procedé, quiero
- false: no, cancelá, mejor no, esperá, todavía no, pará, no gracias`;

export const CONFIRM_CLOSED_ORDER_ACTION_DESCRIPTION =
  'El usuario debe confirmar o cancelar el registro del pedido fuera del horario de atención.';

/** Clasificador tipable de confirmación de pedido en cerrado (borde NLP). */
export async function extractConfirmClosedOrderPending(userMessage: string) {
  return extractPendingTurnResponse({
    userMessage,
    pendingAction: 'confirm_closed_order',
    botQuestion: CONFIRM_CLOSED_ORDER_QUESTION,
    schema: ConfirmClosedOrderPendingSchema,
    valueHints: CONFIRM_CLOSED_ORDER_VALUE_HINTS,
    actionDescription: CONFIRM_CLOSED_ORDER_ACTION_DESCRIPTION,
  });
}

/**
 * Efecto de CONFIRM_CLOSED_ORDER / tipable fulfilled=true:
 * setea `closed_order_confirmed_at`, omite pending y re-despacha el ADD_ITEM.
 */
export async function applyClosedOrderConfirm(
  conversationId: string,
  enrichedCtx: EnrichedContext,
  pendingPayloadId: string
): Promise<HandlerResult | null> {
  await patchConversationMetadata(conversationId, {
    closed_order_confirmed_at: new Date().toISOString(),
  });
  await omitConversationMetadataKeys(conversationId, ['pending_closed_add_item']);
  const pendingCtx = { ...enrichedCtx, payloadId: pendingPayloadId } as EnrichedContext;
  return dispatchInteractive(pendingCtx);
}

/**
 * Efecto de CANCEL_CLOSED_ORDER / tipable fulfilled=false:
 * omite pending y responde mensaje de cancelación.
 */
export async function applyClosedOrderCancel(
  conversationId: string
): Promise<HandlerResult> {
  await omitConversationMetadataKeys(conversationId, ['pending_closed_add_item']);
  return { content: CLOSED_ORDER_CANCELLED_BOT_MESSAGE, isInteractive: false };
}
