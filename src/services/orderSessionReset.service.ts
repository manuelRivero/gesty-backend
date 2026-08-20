/**
 * Limpia el estado de sesión de *pedido* al cancelar el carrito/orden
 * (o al expirar el draft). No toca borrador de reserva ni Goals de reserva
 * (COMPLETAR_RESERVA / RESERVA_PROXIMA), ni onboarding, ni ambassador_ref.
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

/**
 * Claves de metadata de pedido/checkout/CTA/party-size/pendings tipables.
 * Todo lo que pueda contaminar el *siguiente* pedido.
 */
const ORDER_SESSION_OMIT_KEYS = [
  // Shortlist / selección de producto
  'peopleCountResume',
  'pendingProductSelection',
  'pendingQuestion',
  'candidateProductIds',
  'intentCandidates',
  // Legacy shortlist de búsqueda de pedido
  'pendingOrderSelection',
  'pendingOrderMessage',
  'pendingOrderCandidateIds',
  // Tipables / ledgers conversacionales
  'pendingTipables',
  'pendingVariation',
  'pendingAddQuantity',
  'pendingItemNote',
  'pendingOrderLines',
  // Confirmación quitar ítem
  'pendingAction',
  'pendingItemId',
  'pendingItemName',
  'pendingActionAt',
  // Party size / porciones
  'requestedPartySize',
  'peopleCount',
  'pendingProductQueryQuantity',
  'lastListSuggestedQuantity',
  'coveredPortions',
  'missingPortions',
  // CTA / oferta
  'nextActionHintsShown',
  'lastCtaShownAt',
  'lastCtaProductId',
  'lastCtaPayload',
  'lastOffer',
  'lastReferencedProductName',
  // Checkout / fulfillment / cancel
  'pending_fulfillment_action',
  'pending_cancel_disambiguation',
  'pending_closed_add_item',
  'closed_order_confirmed_at',
  // Dirección staged (delegada) — la guardada en customer no se toca
  'pending_address_action',
  'address_soft_asked',
  'pending_address_text',
  'pending_address_lat',
  'pending_address_lng',
  'pending_address_zone_id',
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
  'OBTENER_PERSONAS_DEL_PEDIDO',
  'RECOLECTAR_PARTY_SIZE', // legacy alias — limpiar en reset
  'PEDIDO_POR_EXPIRAR',
  'NEGOCIO_POR_CERRAR',
  'FUERA_DE_COBERTURA',
  'ITEM_SIN_STOCK',
  'PAGO_RECHAZADO',
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
 * Tras cancelar el pedido (o expirar el draft): flags en false, omite claves
 * de sesión de pedido y limpia el Ledger de Goals/Opportunities/Alerts de pedido.
 *
 * Preserva: reservation*, onboarding_*, temp_address, ambassador_ref,
 * COMPLETAR_RESERVA, RESERVA_PROXIMA.
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
