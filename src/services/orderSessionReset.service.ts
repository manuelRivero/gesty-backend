/**
 * Limpia el estado de sesión de *pedido* al cancelar el carrito/orden.
 * No toca borrador de reserva ni Goals de reserva (COMPLETAR_RESERVA).
 */

import { prisma } from '../lib/prisma';
import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
  updateConversationState,
} from '../repositories';
import { COMPLEMENT_METADATA_KEY } from '../domain/complementSuggestions.schema';
import type { ConversationMetadata } from './productQuery/types';
import { normalizeMetadata } from './productQuery/utils';

/** Claves de metadata de pedido/checkout/CTA/party-size (no reserva). */
const ORDER_SESSION_OMIT_KEYS = [
  'peopleCountResume',
  'pendingProductSelection',
  'pendingQuestion',
  'candidateProductIds',
  'pendingAction',
  'pendingItemId',
  'pendingItemName',
  'pendingActionAt',
  'requestedPartySize',
  'peopleCount',
  'pendingProductQueryQuantity',
  'lastListSuggestedQuantity',
  'coveredPortions',
  'missingPortions',
  'nextActionHintsShown',
  'lastCtaShownAt',
  'lastCtaProductId',
  'lastCtaPayload',
  'lastOffer',
  'lastReferencedProductName',
  'pending_fulfillment_action',
  'pending_cancel_disambiguation',
  'pending_closed_add_item',
  'closed_order_confirmed_at',
  'pending_address_action',
  'address_soft_asked',
  COMPLEMENT_METADATA_KEY,
  'name_refusal_count',
  'address_refusal_count',
] as const;

/** Entradas del Ledger ligadas al pedido (no a reserva). */
const ORDER_LEDGER_KEYS = [
  'COMPLETAR_PEDIDO',
  'CONFIRMAR_OFERTA',
  'SUGERIR_COMPLEMENTO',
  'SUGERIR_DIRECCION',
  'OFRECER_PROMOCION',
  'RECOLECTAR_PARTY_SIZE',
  'PEDIDO_POR_EXPIRAR',
  'CONFIRMAR_PAGO_ONLINE',
  'DESBLOQUEAR_PEDIDO_CERRADO',
  'RETOMAR_TAREA_INTERRUMPIDA',
  'RESPONDER_CONSULTA_PENDIENTE',
  'DESAMBIGUAR_PRODUCTO',
  'CONFIRMAR_ELIMINACION',
  'OBTENER_NOMBRE',
  'OBTENER_DIRECCION',
] as const;

/**
 * Tras cancelar el pedido: flags en false, omite claves de sesión de pedido
 * y limpia el Ledger de Goals/Opportunities/Alerts de pedido.
 */
export async function clearOrderSessionAfterCancel(
  conversationId: string
): Promise<void> {
  const row = await prisma.conversation_state.findUnique({
    where: { conversation_id: conversationId },
    select: { metadata: true },
  });
  const meta = normalizeMetadata(row?.metadata);

  const prevLedger = meta.intentLedger ?? {};
  const nextLedger: NonNullable<ConversationMetadata['intentLedger']> = {
    ...prevLedger,
  };
  for (const key of ORDER_LEDGER_KEYS) {
    delete nextLedger[key];
  }

  await patchConversationMetadata(conversationId, {
    checkout_active: false,
    awaitingPartySize: false,
    awaitingPeopleCount: false,
    awaitingIntentConfirmation: false,
    awaiting_name: false,
    awaiting_address: false,
    pending_address_confirmation: false,
    pending_fulfillment_action: null,
    requestedPartySize: null,
    peopleCount: null,
  });

  await omitConversationMetadataKeys(conversationId, [
    ...ORDER_SESSION_OMIT_KEYS,
  ]);

  if (Object.keys(nextLedger).length === 0) {
    await omitConversationMetadataKeys(conversationId, ['intentLedger']);
  } else {
    await patchConversationMetadata(conversationId, { intentLedger: nextLedger });
  }

  try {
    await updateConversationState(conversationId, { mode: 'GLOBAL' });
  } catch {
    /* sin fila de state: no bloquea el cancel */
  }

  try {
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastReferencedProductId: null },
    });
  } catch {
    /* conversación inexistente: ignore */
  }
}
