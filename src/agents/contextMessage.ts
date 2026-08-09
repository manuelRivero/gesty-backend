/**
 * Construcción del `[ESTADO DEL CLIENTE]` que precede al mensaje del cliente
 * en cada turno del agente ReAct principal (ver `reactAgent.ts`).
 *
 * Extraído a su propio módulo para poder testearlo sin levantar el agente
 * completo (Tarea 1.3 de PLAN-ACCION-CALIDAD-CONVERSACIONAL.md).
 *
 * D3: las líneas del bloque son condicionales — solo se incluyen cuando
 * aportan algo al turno actual. Con criterio conservador: ante la duda, se
 * incluyen. Esto evita que el modelo narre estado que no viene al caso
 * (síntoma 1 del plan de calidad conversacional).
 */

import { prisma } from '../lib/prisma';
import type { EnrichedContext } from '../controllers/webhook/types';
import { getRequestedPartySize, normalizeMetadata } from '../services/productQuery/utils';
import {
  buildLastOfferContextLines,
} from '../services/lastOffer.service';
import {
  buildOrderCompletionContextLines,
  getOrderCompletionLedger,
  deriveOrderCompletionGoal,
  computeOrderCompletionPermission,
} from '../services/orderCompletionGoal.service';
import {
  buildReservationCompletionContextLines,
  getReservationCompletionLedger,
  hasReservationDraftInProgress,
  deriveReservationCompletionGoal,
  computeReservationCompletionPermission,
} from '../services/reservationCompletionGoal.service';
import { findActiveEnvironmentsByBusinessId } from '../repositories/reservation.repository';

export const buildContextMessage = async (ctx: EnrichedContext): Promise<string> => {
  const userMsg = ctx.message?.text?.body ?? '';
  const meta = normalizeMetadata(ctx.conversationState?.metadata);
  const partySize = getRequestedPartySize(meta);
  const checkoutActive = meta.checkout_active === true;

  const businessId =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { id: string }).id
      : '';
  const customerPhone =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { phone_number?: string }).phone_number ?? ctx.to
      : ctx.to;

  let cartSummary: string | null = null;
  let fulfillmentType: string | null = null;
  let hasItems = false;
  let hasActiveDraft = false;

  if (businessId && customerPhone) {
    try {
      const draft = await prisma.draft_order.findFirst({
        where: {
          business_id: businessId,
          customer_phone: customerPhone,
          status: 'active',
        },
        select: {
          fulfillment_type: true,
          _count: { select: { draft_order_item: true } },
        },
      });
      if (draft) {
        hasActiveDraft = true;
        const count = draft._count.draft_order_item;
        hasItems = count > 0;
        cartSummary = count > 0 ? `${count} ítem(s) en carrito` : 'carrito vacío';
        fulfillmentType = draft.fulfillment_type
          ? `${draft.fulfillment_type} (solo checkout puede cambiarlo)`
          : null;
      }
    } catch {
      /* el agente puede usar get_cart */
    }
  }

  const reservationDraft = meta.reservation_draft;
  const reservationAgentActive = meta.reservation_agent_active === true;
  const hasReservationDraft = hasReservationDraftInProgress(reservationDraft);
  let hasEnvironments = false;
  if (hasReservationDraft && businessId) {
    try {
      const environments = await findActiveEnvironmentsByBusinessId(businessId);
      hasEnvironments = environments.length > 0;
    } catch {
      /* si falla, se asume sin ambientes — solo afecta el texto del hint */
    }
  }

  const partySizeLine = partySize
    ? `${partySize} (guía de cantidad a pedir, NO filtro de serves_people)`
    : 'no informado — preguntar solo si el cliente consulta platos o pide comida en este turno';

  const detection = ctx.detection;
  const nlpHint = detection
    ? {
        intent: String(detection.intent),
        detectedProductName: detection.detectedProductName ?? null,
        quantity: detection.quantity ?? null,
      }
    : null;

  // ADR-0009: a lo sumo un Intent activo por turno. Con dos Goals derivados
  // (Fase 0 y Fase 1b) hace falta un arbitraje explícito: se calcula el
  // permiso puro de cada uno primero, y si ambos ganarían el turno, se
  // suprime uno antes de construir las líneas (evita consumir presupuesto
  // de ambos y mostrarle al modelo dos objetivos a la vez). Empate entre
  // Goals de igual presión ("reanudable"): gana COMPLETAR_PEDIDO — un pago
  // pendiente es más urgente que una reserva a futuro.
  const orderLedger = getOrderCompletionLedger(meta);
  const orderGoal = deriveOrderCompletionGoal({ hasItems, checkoutActive }, orderLedger);
  const orderPermission = computeOrderCompletionPermission(orderGoal, orderLedger);

  const reservationLedger = getReservationCompletionLedger(meta);
  const reservationGoal = deriveReservationCompletionGoal(
    { hasDraft: hasReservationDraft, reservationAgentActive },
    reservationLedger
  );
  const reservationPermission = computeReservationCompletionPermission(
    reservationGoal,
    reservationLedger
  );
  const suppressReservation = orderPermission.granted && reservationPermission.granted;

  const lastOfferLines = buildLastOfferContextLines(meta, nlpHint);
  const hasActiveOffer = lastOfferLines.length > 0;

  const lines = [
    `- Personas para el pedido: ${partySizeLine}`,
    // D3: la línea del carrito solo aporta cuando hay algo que decir sobre
    // él (ítems, checkout en curso u oferta activa pendiente de respuesta).
    hasItems || checkoutActive || hasActiveOffer
      ? `- Carrito: ${cartSummary ?? 'sin pedido activo'}`
      : null,
    // Con fulfillment definido en el draft hay algo real que informar; en el
    // resto de los casos ("no aplica", "sin elegir") es ruido en cada turno.
    hasActiveDraft && fulfillmentType ? `- Tipo de entrega: ${fulfillmentType}` : null,
    // El caso informativo para el modelo es "activa" (cambia cómo debe
    // comportarse ese turno); "inactiva" es el estado por defecto.
    checkoutActive ? '- Sesión de checkout: activa' : null,
    ...lastOfferLines,
    ...buildOrderCompletionContextLines({
      facts: { hasItems, checkoutActive },
      ledger: orderLedger,
      conversationId: ctx.conversationId,
    }),
    ...buildReservationCompletionContextLines({
      facts: { hasDraft: hasReservationDraft, reservationAgentActive },
      ledger: reservationLedger,
      conversationId: ctx.conversationId,
      suppressedBySaliency: suppressReservation,
      draft: reservationDraft,
      hasEnvironments,
    }),
  ].filter((line): line is string => line !== null);

  if (lines.length === 0) {
    return userMsg;
  }

  return `[ESTADO DEL CLIENTE]\n${lines.join('\n')}\n\n${userMsg}`;
};
