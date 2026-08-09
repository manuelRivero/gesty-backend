/**
 * Construcción del `[ESTADO DEL CLIENTE]` que precede al mensaje del cliente
 * en cada turno del agente ReAct principal (ver `reactAgent.ts`).
 *
 * Familia Intent (ADR-0008/0009): un solo Intent activo por turno lo decide
 * `rankActiveIntent` — nunca el LLM.
 */

import type { MenuCategoryTag } from '@prisma/client';
import { prisma } from '../lib/prisma';
import type { EnrichedContext } from '../controllers/webhook/types';
import { getRequestedPartySize, normalizeMetadata } from '../services/productQuery/utils';
import {
  deriveConfirmOfferCandidate,
  getConfirmOfferLedgerEntry,
  getLastOffer,
  recordConfirmOfferSurfaced,
} from '../services/lastOffer.service';
import {
  getOrderCompletionLedger,
  recordOrderCompletionSurfaced,
  resetOrderCompletionLedgerIfCartEmpty,
} from '../services/orderCompletionGoal.service';
import {
  getReservationCompletionLedger,
  hasReservationDraftInProgress,
  recordReservationCompletionSurfaced,
} from '../services/reservationCompletionGoal.service';
import { findActiveEnvironmentsByBusinessId } from '../repositories/reservation.repository';
import {
  buildIntentLedgerView,
  deriveIntentCandidates,
  rankActiveIntent,
  type IntentLedgerView,
} from '../services/intent/activeIntent.service';
import {
  deriveCollectPartySizeCandidate,
  deriveSuggestAddressCandidate,
  deriveSuggestComplementCandidate,
  recordOpportunitySurfaced,
} from '../services/intent/opportunities.service';
import {
  deriveFueraDeCoberturaCandidate,
  derivePedidoPorExpirarCandidate,
  recordAlertEmitted,
  recordResolutionAlertSurfaced,
} from '../services/intent/alerts.service';
import {
  deriveConfirmarPagoOnlineCandidate,
  deriveDesbloquearPedidoCerradoCandidate,
  deriveRetomarTareaCandidate,
  recordCatalogGoalSurfaced,
} from '../services/intent/catalogGoals.service';
import { collectCategoryTagsInDraftCart } from '../helpers/complementaryMenu.helper';

const FOOD_RELATED_INTENTS = new Set([
  'ORDER_FOOD',
  'PRODUCT_QUERY',
  'ADD_ITEM',
  'VIEW_MENU',
  'MODIFY_QUANTITY',
]);

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
  let draftOrderId: string | null = null;
  let draftExpiresAt: Date | null = null;
  let cartTags = new Set<MenuCategoryTag>();

  if (businessId && customerPhone) {
    try {
      const draft = await prisma.draft_order.findFirst({
        where: {
          business_id: businessId,
          customer_phone: customerPhone,
          status: 'active',
        },
        select: {
          id: true,
          fulfillment_type: true,
          expires_at: true,
          _count: { select: { draft_order_item: true } },
        },
      });
      if (draft) {
        hasActiveDraft = true;
        draftOrderId = draft.id;
        draftExpiresAt = draft.expires_at;
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

  if (draftOrderId && businessId && hasItems && !checkoutActive) {
    try {
      cartTags = await collectCategoryTagsInDraftCart(draftOrderId, businessId);
    } catch {
      /* sin tags, SUGERIR_COMPLEMENTO no se deriva */
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

  const orderLedger = getOrderCompletionLedger(meta);
  const reservationLedger = getReservationCompletionLedger(meta);

  void resetOrderCompletionLedgerIfCartEmpty(
    ctx.conversationId,
    { hasItems, checkoutActive },
    orderLedger
  ).catch((err) => console.error('[goal] failed to reset order completion ledger:', err));

  const confirmOfferCandidate = deriveConfirmOfferCandidate(meta);
  const confirmOfferLedger = getConfirmOfferLedgerEntry(meta);

  const hasAddress = ctx.hasAddress === true;
  const blockingAddressIntent =
    checkoutActive ||
    meta.awaiting_address === true ||
    meta.onboarding_agent_active === true;

  const foodRelatedTurn = Boolean(
    detection && FOOD_RELATED_INTENTS.has(String(detection.intent))
  );

  const isInCoverage = ctx.isInCoverage === true;

  let paymentLinkEmitted = false;
  if (draftOrderId) {
    try {
      const pendingIntent = await prisma.payment_intent.findFirst({
        where: {
          draft_order_id: draftOrderId,
          status: 'pending',
          init_point: { not: null },
        },
        select: { id: true },
      });
      paymentLinkEmitted = Boolean(pendingIntent);
    } catch {
      /* sin pago online pendiente */
    }
  }

  const extras = [
    deriveFueraDeCoberturaCandidate(
      { hasAddress, isInCoverage },
      meta.intentLedger?.FUERA_DE_COBERTURA
    ),
    derivePedidoPorExpirarCandidate(
      { hasItems, expiresAt: draftExpiresAt },
      meta.intentLedger?.PEDIDO_POR_EXPIRAR
    ),
    deriveConfirmarPagoOnlineCandidate(
      { paymentLinkEmitted, paymentAccredited: false },
      meta.intentLedger?.CONFIRMAR_PAGO_ONLINE
    ),
    deriveDesbloquearPedidoCerradoCandidate(
      { pendingClosedAddItem: Boolean(meta.pending_closed_add_item) },
      meta.intentLedger?.DESBLOQUEAR_PEDIDO_CERRADO
    ),
    deriveRetomarTareaCandidate(
      { hasInterruptedTask: Boolean(meta.peopleCountResume) },
      meta.intentLedger?.RETOMAR_TAREA_INTERRUMPIDA
    ),
    deriveSuggestComplementCandidate(
      { cartTags, checkoutActive },
      meta.intentLedger?.SUGERIR_COMPLEMENTO
    ),
    deriveSuggestAddressCandidate(
      { hasAddress, blockingAddressIntent },
      meta.intentLedger?.SUGERIR_DIRECCION
    ),
    deriveCollectPartySizeCandidate(
      { foodRelatedTurn, partySize: partySize ?? null, checkoutActive },
      meta.intentLedger?.RECOLECTAR_PARTY_SIZE
    ),
    confirmOfferCandidate,
  ].filter((c): c is NonNullable<typeof c> => c != null);

  const candidates = deriveIntentCandidates({
    order: {
      facts: { hasItems, checkoutActive },
      ledger: orderLedger,
    },
    reservation: {
      facts: { hasDraft: hasReservationDraft, reservationAgentActive },
      ledger: reservationLedger,
      draft: reservationDraft,
      hasEnvironments,
    },
    extras,
  });

  const extrasLedger: IntentLedgerView = {};
  if (confirmOfferLedger) extrasLedger.CONFIRMAR_OFERTA = confirmOfferLedger;
  if (meta.intentLedger?.SUGERIR_COMPLEMENTO) {
    extrasLedger.SUGERIR_COMPLEMENTO = meta.intentLedger.SUGERIR_COMPLEMENTO;
  }
  if (meta.intentLedger?.SUGERIR_DIRECCION) {
    extrasLedger.SUGERIR_DIRECCION = meta.intentLedger.SUGERIR_DIRECCION;
  }
  if (meta.intentLedger?.RECOLECTAR_PARTY_SIZE) {
    extrasLedger.RECOLECTAR_PARTY_SIZE = meta.intentLedger.RECOLECTAR_PARTY_SIZE;
  }
  if (meta.intentLedger?.PEDIDO_POR_EXPIRAR) {
    extrasLedger.PEDIDO_POR_EXPIRAR = meta.intentLedger.PEDIDO_POR_EXPIRAR;
  }
  if (meta.intentLedger?.FUERA_DE_COBERTURA) {
    extrasLedger.FUERA_DE_COBERTURA = meta.intentLedger.FUERA_DE_COBERTURA;
  }
  if (meta.intentLedger?.CONFIRMAR_PAGO_ONLINE) {
    extrasLedger.CONFIRMAR_PAGO_ONLINE = meta.intentLedger.CONFIRMAR_PAGO_ONLINE;
  }
  if (meta.intentLedger?.DESBLOQUEAR_PEDIDO_CERRADO) {
    extrasLedger.DESBLOQUEAR_PEDIDO_CERRADO = meta.intentLedger.DESBLOQUEAR_PEDIDO_CERRADO;
  }
  if (meta.intentLedger?.RETOMAR_TAREA_INTERRUMPIDA) {
    extrasLedger.RETOMAR_TAREA_INTERRUMPIDA = meta.intentLedger.RETOMAR_TAREA_INTERRUMPIDA;
  }

  const ledgerView = buildIntentLedgerView({
    order: orderLedger,
    reservation: reservationLedger,
    extras: extrasLedger,
  });
  const ranked = rankActiveIntent(candidates, ledgerView, {
    conversationId: ctx.conversationId,
  });

  if (ranked.active?.type === 'COMPLETAR_PEDIDO') {
    void recordOrderCompletionSurfaced(ctx.conversationId, orderLedger).catch((err) =>
      console.error('[goal] failed to record order completion surfaced:', err)
    );
  } else if (ranked.active?.type === 'COMPLETAR_RESERVA') {
    void recordReservationCompletionSurfaced(ctx.conversationId, reservationLedger).catch(
      (err) => console.error('[goal] failed to record reservation completion surfaced:', err)
    );
  } else if (ranked.active?.type === 'CONFIRMAR_OFERTA') {
    void recordConfirmOfferSurfaced(ctx.conversationId, meta).catch((err) =>
      console.error('[intent] failed to record CONFIRMAR_OFERTA surfaced:', err)
    );
  } else if (
    ranked.active?.type === 'SUGERIR_COMPLEMENTO' ||
    ranked.active?.type === 'SUGERIR_DIRECCION' ||
    ranked.active?.type === 'RECOLECTAR_PARTY_SIZE'
  ) {
    void recordOpportunitySurfaced(ctx.conversationId, ranked.active.type, meta).catch(
      (err) => console.error('[intent] failed to record opportunity surfaced:', err)
    );
  } else if (ranked.active?.type === 'PEDIDO_POR_EXPIRAR') {
    void recordAlertEmitted(ctx.conversationId, 'PEDIDO_POR_EXPIRAR', meta).catch((err) =>
      console.error('[intent] failed to record PEDIDO_POR_EXPIRAR emitted:', err)
    );
  } else if (ranked.active?.type === 'FUERA_DE_COBERTURA') {
    void recordResolutionAlertSurfaced(ctx.conversationId, 'FUERA_DE_COBERTURA', meta).catch(
      (err) => console.error('[intent] failed to record FUERA_DE_COBERTURA surfaced:', err)
    );
  } else if (
    ranked.active?.type === 'CONFIRMAR_PAGO_ONLINE' ||
    ranked.active?.type === 'DESBLOQUEAR_PEDIDO_CERRADO' ||
    ranked.active?.type === 'RETOMAR_TAREA_INTERRUMPIDA'
  ) {
    void recordCatalogGoalSurfaced(ctx.conversationId, ranked.active.type, meta).catch((err) =>
      console.error('[intent] failed to record catalog goal surfaced:', err)
    );
  }

  const offerStillAlive = Boolean(getLastOffer(meta) && confirmOfferCandidate);
  const intentLines =
    ranked.active && ranked.permission.granted
      ? ranked.active.hint.split('\n')
      : [];

  const nlpLines = nlpHint
    ? [
        `- Hint NLP (secundario, no vinculante): intent=${nlpHint.intent}, ` +
          `producto=${nlpHint.detectedProductName ?? 'ninguno'}, ` +
          `cantidad=${nlpHint.quantity ?? 'ninguna'}`,
      ]
    : [];

  const lines = [
    `- Personas para el pedido: ${partySizeLine}`,
    hasItems || checkoutActive || offerStillAlive
      ? `- Carrito: ${cartSummary ?? 'sin pedido activo'}`
      : null,
    hasActiveDraft && fulfillmentType ? `- Tipo de entrega: ${fulfillmentType}` : null,
    checkoutActive ? '- Sesión de checkout: activa' : null,
    ...intentLines,
    ...nlpLines,
  ].filter((line): line is string => line !== null);

  if (lines.length === 0) {
    return userMsg;
  }

  return `[ESTADO DEL CLIENTE]\n${lines.join('\n')}\n\n${userMsg}`;
};
