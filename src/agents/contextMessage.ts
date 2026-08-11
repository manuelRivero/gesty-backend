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
import { buildPartySizeJustConfirmedContextLines } from '../services/peopleCountGate.service';
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
import { buildPendingVariationContextLines } from '../services/pendingVariation.service';
import { buildPendingAddQuantityContextLines } from '../services/pendingAddQuantity.service';
import {
  buildPendingItemNoteContextLines,
  getPendingItemNote,
} from '../services/pendingItemNote.service';
import {
  MANAGEMENT_TOOL_HINT,
  type TipableManagementAction,
} from '../services/pendingTipables.service';

/** Hint interno cuando hay shortlist pendiente (SELECT_FROM_LIST / product query). */
export async function buildPendingProductSelectionLines(
  meta: {
    pendingProductSelection?: boolean;
    pendingQuestion?: string;
    candidateProductIds?: string[];
    pendingTipables?: {
      management?: TipableManagementAction[];
    } | null;
    pendingItemNote?: unknown;
  },
  businessId: string
): Promise<string[]> {
  if (!meta.pendingProductSelection) return [];
  const ids = (meta.candidateProductIds ?? []).filter(
    (id): id is string => typeof id === 'string' && id.length > 0
  );
  if (ids.length === 0) return [];

  let labeled = ids.map((id) => `id:${id}`);
  if (businessId) {
    try {
      const rows = await prisma.menu_item.findMany({
        where: { id: { in: ids }, business_id: businessId, is_available: true },
        select: { id: true, name: true },
      });
      const byId = new Map(rows.map((r) => [r.id, r.name]));
      labeled = ids.map((id) => {
        const name = byId.get(id);
        return name ? `*${name}* (productId: ${id})` : `productId: ${id}`;
      });
    } catch {
      labeled = ids.map((id) => `productId: ${id}`);
    }
  }

  const noteTakesPriority =
    Boolean(getPendingItemNote(meta)) ||
    (meta.pendingTipables?.management ?? []).includes('ITEM_NOTE');

  const lines = [
    ...(noteTakesPriority
      ? [
          '- PRIORIDAD NOTA: tipable ITEM_NOTE o pendingItemNote activo — ' +
            'NO fuerces add_cart_item del shortlist; resolvé la nota ' +
            '(start_item_note / update_item_note / clear_pending_item_note).',
        ]
      : []),
    '- Selección de producto pendiente: el turno anterior ofreció elegir entre varios platos. ' +
      'El mensaje actual del cliente probablemente responde cuál quiere (nombre parcial, ' +
      '"el primero", "el de la plancha", etc.).',
    `- Candidatos (usá estos productId; no inventes otros): ${labeled.join(' | ')}.`,
    '- Si matchea uno con claridad: present_product_cta(ADD_ITEM) o add_cart_item con ese productId. ' +
      'Si queda ambiguo entre candidatos, pedí aclaración nombrándolos. ' +
      'Si rechaza o cambia de tema, no insistas con la lista.',
    '- PRIORIDAD: si el mensaje es gestión tipable (menú, ver pedido, modificar, finalizar, nota) ' +
      'o pide otro plato / instrucción de preparación ("poca sal"), NO fuerces add_cart_item del shortlist.',
  ];
  const q = meta.pendingQuestion?.trim();
  if (q) {
    lines.push(`- Consulta original del cliente (contexto): "${q.slice(0, 200)}".`);
  }
  return lines;
}

/** Acciones de gestión tipables del último mensaje (ledger, no regex). */
export function buildPendingTipablesManagementLines(meta: {
  pendingTipables?: {
    offeredAt?: string;
    management?: TipableManagementAction[];
  } | null;
}): string[] {
  const actions = meta.pendingTipables?.management?.filter(Boolean) ?? [];
  if (actions.length === 0) return [];

  const mapped = actions
    .map((a) => `${a} → ${MANAGEMENT_TOOL_HINT[a] ?? 'tool correspondiente'}`)
    .join('; ');

  return [
    '- Tipables de gestión ofrecidos en el mensaje anterior (el cliente puede tiparlos): ' +
      mapped +
      '.',
    '- Si el mensaje actual apunta a uno de esos tipables, ejecutá esa tool/señal. ' +
      'Para ITEM_NOTE: si solo tipó «nota» sin detalle → start_item_note() y mostrá askMessage ' +
      '(PROHIBIDO add_cart_item / present_complement_suggestions / present_product_cta). ' +
      'Si ya trae plato+nota (ej. "la papa con poca sal"): get_cart → update_item_note ' +
      '(draftOrderItemId / draftOrderItemIds si hay ≥2 líneas del mismo plato; si no, productId) en el mismo turno; ' +
      'solo desambiguá si hay ≥2 matches o falta el texto de la nota.',
  ];
}

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
    // SUGERIR_DIRECCION: no se inyecta en el híbrido — dirección solo onboarding/checkout.
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
  } else if (ranked.active?.type === 'RECOLECTAR_PARTY_SIZE') {
    // SUGERIR_COMPLEMENTO se registra al presentar la lista (tool), no al inyectar el hint.
    // SUGERIR_DIRECCION no se cablea al híbrido.
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

  // Dual inject: Opportunity de menú opcional junto al Goal/activo, si tiene permiso
  // y el activo no es Alert ni Goal blocking (ADR-0009 suavizado: mencionable con permiso).
  const pendingItemNoteActive = Boolean(getPendingItemNote(meta));

  const complementCandidate = extras.find((c) => c.type === 'SUGERIR_COMPLEMENTO');
  const activeBlocksOptional =
    ranked.active?.kind === 'alert' ||
    (ranked.active?.kind === 'goal' && ranked.active.pressure === 'blocking');
  // pendingItemNote gana sobre la Opportunity de complemento (misma ola).
  const optionalComplementLines =
    complementCandidate &&
    ranked.active?.type !== 'SUGERIR_COMPLEMENTO' &&
    !activeBlocksOptional &&
    !pendingItemNoteActive
      ? complementCandidate.hint.split('\n')
      : [];

  const pendingSelectionLines = await buildPendingProductSelectionLines(meta, businessId);
  const pendingTipablesLines = buildPendingTipablesManagementLines(meta);
  const pendingItemNoteLines = buildPendingItemNoteContextLines(meta);

  const pendingCancel = meta.pending_cancel_disambiguation;
  const pendingCancelLines =
    pendingCancel &&
    typeof pendingCancel === 'object' &&
    typeof pendingCancel.orderRef === 'string'
      ? [
          `- Cancelación pendiente de desambiguar: hay carrito en armado Y pedido confirmado #${pendingCancel.orderRef}. ` +
            `Si el cliente elige, llamá cancel_order(target: "draft") para el carrito o cancel_order(target: "order") para el pedido creado. ` +
            `No inventes el cancelado en prosa.`,
        ]
      : [];

  const pendingVariationLines = buildPendingVariationContextLines(meta);
  const pendingAddQuantityLines = buildPendingAddQuantityContextLines(meta);
  const partySizeJustConfirmedLines = buildPartySizeJustConfirmedContextLines(
    ctx.partySizeJustConfirmed
  );

  const lines = [
    `- Personas para el pedido: ${partySizeLine}`,
    ...partySizeJustConfirmedLines,
    hasItems || checkoutActive || offerStillAlive
      ? `- Carrito: ${cartSummary ?? 'sin pedido activo'}`
      : null,
    hasActiveDraft && fulfillmentType ? `- Tipo de entrega: ${fulfillmentType}` : null,
    checkoutActive ? '- Sesión de checkout: activa' : null,
    ...pendingItemNoteLines,
    ...pendingTipablesLines,
    ...pendingSelectionLines,
    ...pendingVariationLines,
    ...pendingAddQuantityLines,
    ...pendingCancelLines,
    ...intentLines,
    ...optionalComplementLines,
  ].filter((line): line is string => line !== null);

  if (lines.length === 0) {
    return userMsg;
  }

  return `[ESTADO DEL CLIENTE]\n${lines.join('\n')}\n\n${userMsg}`;
};
