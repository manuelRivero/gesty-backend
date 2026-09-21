/**
 * Cambio de dominio híbrido → reservas con carrito activo.
 *
 * Si hay ítems en el draft, `start_reservation_session` no abre la reserva:
 * pide confirmar cancelar el pedido. Tipable + botones comparten efecto (§3.11).
 */

import { z } from 'zod';
import { prisma } from '../lib/prisma';
import type { conversation } from '@prisma/client';
import type { HandlerResult } from '../controllers/webhook/types';
import type { WhatsAppInteractiveMessage } from '../domain/intent/whatsappTemplates';
import { patchConversationMetadata, omitConversationMetadataKeys } from '../repositories';
import { extractPendingTurnResponse } from './ai/extractPendingTurnResponse';
import { buildCancelOrderMessage } from './order.service';
import { formatBotUserMessage, normalizeMetadata } from './productQuery/utils';
import type { ConversationMetadata } from './productQuery/types';

export const PENDING_SWITCH_TO_RESERVATION_KEY = 'pending_switch_to_reservation' as const;

export const CONFIRM_CANCEL_ORDER_FOR_RESERVATION_PAYLOAD =
  'CONFIRM_CANCEL_ORDER_FOR_RESERVATION' as const;
export const DECLINE_SWITCH_TO_RESERVATION_PAYLOAD =
  'DECLINE_SWITCH_TO_RESERVATION' as const;

export type PendingSwitchToReservation = {
  reason: string;
  askedAt: string;
};

export const SwitchToReservationPendingSchema = z.object({
  confirmed: z.boolean(),
});
export type SwitchToReservationPendingValue = z.infer<
  typeof SwitchToReservationPendingSchema
>;

export const SWITCH_TO_RESERVATION_QUESTION =
  'Tenés un pedido en curso. ¿Querés cancelarlo para hacer una reserva?';

export const SWITCH_TO_RESERVATION_VALUE_HINTS = `{
  "confirmed": true | false
}
- true: sí, dale, cancelá el pedido, cancelar y reservar, ok, confirmo, adelante
- false: no, mejor no, sigo con el pedido, no cancelar, dejá el carrito, después reservo`;

export const SWITCH_TO_RESERVATION_ACTION_DESCRIPTION =
  'El usuario debe confirmar si cancela el pedido en curso para pasar a reservar mesa, o si prefiere seguir con el pedido.';

export async function countActiveCartItems(params: {
  businessId: string;
  customerPhone: string;
}): Promise<number> {
  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: params.businessId,
      customer_phone: params.customerPhone,
      status: 'active',
    },
    select: { _count: { select: { draft_order_item: true } } },
  });
  return draft?._count.draft_order_item ?? 0;
}

export function getPendingSwitchToReservation(
  metadata: unknown
): PendingSwitchToReservation | null {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  const raw = meta.pending_switch_to_reservation;
  if (!raw || typeof raw !== 'object') return null;
  const reason = typeof raw.reason === 'string' ? raw.reason : '';
  const askedAt = typeof raw.askedAt === 'string' ? raw.askedAt : '';
  if (!askedAt) return null;
  return { reason, askedAt };
}

export async function setPendingSwitchToReservation(
  conversationId: string,
  reason: string
): Promise<void> {
  await patchConversationMetadata(conversationId, {
    pending_switch_to_reservation: {
      reason: reason.trim() || 'el cliente quiere reservar',
      askedAt: new Date().toISOString(),
    },
  });
}

export async function clearPendingSwitchToReservation(
  conversationId: string
): Promise<void> {
  await omitConversationMetadataKeys(conversationId, [
    PENDING_SWITCH_TO_RESERVATION_KEY,
  ]);
}

export async function extractSwitchToReservationPending(userMessage: string) {
  return extractPendingTurnResponse({
    userMessage,
    pendingAction: 'confirm_cancel_order_for_reservation',
    botQuestion: SWITCH_TO_RESERVATION_QUESTION,
    schema: SwitchToReservationPendingSchema,
    valueHints: SWITCH_TO_RESERVATION_VALUE_HINTS,
    actionDescription: SWITCH_TO_RESERVATION_ACTION_DESCRIPTION,
  });
}

export function buildSwitchToReservationConfirmMessage(): WhatsAppInteractiveMessage {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Pedido en curso' },
      body: {
        text: formatBotUserMessage(
          'Pedido en curso',
          '🛒',
          `${SWITCH_TO_RESERVATION_QUESTION}\n\nSi cancelás, borramos el carrito y armamos la reserva. Si no, seguimos con tu pedido.`
        ),
      },
      footer: { text: 'Reserva o pedido' },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: CONFIRM_CANCEL_ORDER_FOR_RESERVATION_PAYLOAD,
              title: 'Sí, cancelar',
            },
          },
          {
            type: 'reply',
            reply: {
              id: DECLINE_SWITCH_TO_RESERVATION_PAYLOAD,
              title: 'No, seguir pedido',
            },
          },
        ],
      },
    },
  };
}

export function buildKeepOrderSkipReservationMessage(): string {
  return formatBotUserMessage(
    'Seguimos con tu pedido',
    '🛒',
    'Perfecto, dejamos el carrito como está. Cuando quieras reservar mesa, cancelá el pedido primero o terminá la compra.'
  );
}

/**
 * Confirmó: wipe del dominio pedido (draft/carrito) + limpia pending.
 * El caller abre la sesión de reservas en el mismo turno y responde con
 * el resultado del agente de reservas (el mensaje de cancel queda en historial).
 */
export async function applySwitchToReservationConfirm(params: {
  conversation: conversation;
  businessId: string;
  customerPhone: string;
}): Promise<void> {
  await buildCancelOrderMessage(
    params.conversation,
    params.businessId,
    params.customerPhone,
    { target: 'draft' }
  );
  await clearPendingSwitchToReservation(params.conversation.id);
}

export async function applySwitchToReservationDecline(
  conversationId: string
): Promise<HandlerResult> {
  await clearPendingSwitchToReservation(conversationId);
  return {
    content: buildKeepOrderSkipReservationMessage(),
    isInteractive: false,
    skipBodyHumanization: true,
  };
}

export function buildSwitchToReservationContextLines(metadata: unknown): string[] {
  const pending = getPendingSwitchToReservation(metadata);
  if (!pending) return [];
  return [
    `- Pendiente: confirmar cancelar pedido para pasar a reserva ("${SWITCH_TO_RESERVATION_QUESTION}").`,
    '  Si confirma: el sistema hace wipe del carrito y abre reservas (no digas que el pedido sigue).',
    '  Si rechaza: se mantiene el carrito; no llames start_reservation_session.',
  ];
}
