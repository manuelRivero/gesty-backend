/**
 * Subgrafos `interactive` y `nlp`.
 *
 * Interactive: payloads de botón → mapper + handlers (sin ReAct).
 * NLP (texto libre, sin Ownership de sesión): un solo camino ReAct híbrido.
 * Sin clasificador de intent. Fallback a `dispatchIntent` solo si el agente
 * explota (el stub de detection es UNKNOWN → FallbackHandler). En 429 se
 * responde un mensaje corto, sin despachar.
 */

import { dispatchIntent, dispatchInteractive } from '../../../controllers/webhook/dispachers';
import { parseAddItemButtonPayload } from '../../../controllers/webhook/utils';
import { prisma } from '../../../lib/prisma';
import { hasVariations } from '../../../services/menu/menuItemVariations';
import {
  isConfirmedAddQuantity,
  needsAddQuantityConfirmation,
  suggestAddQuantity,
} from '../../../services/addQuantitySuggestion';
import {
  CONFIRM_CLOSED_ORDER,
  CANCEL_CLOSED_ORDER,
  buildClosedOrderConfirmationMessage,
} from '../../../services/businessHours.service';
import {
  applyClosedOrderCancel,
  applyClosedOrderConfirm,
  extractConfirmClosedOrderPending,
} from '../../../services/closedOrderConfirm.service';
import {
  CONFIRM_CANCEL_ORDER_FOR_RESERVATION_PAYLOAD,
  DECLINE_SWITCH_TO_RESERVATION_PAYLOAD,
  applySwitchToReservationConfirm,
  applySwitchToReservationDecline,
  buildSwitchToReservationConfirmMessage,
  clearPendingSwitchToReservation,
  countActiveCartItems,
  extractSwitchToReservationPending,
  getPendingSwitchToReservation,
} from '../../../services/switchToReservationConfirm.service';
import type { IntentDetectionResult } from '../../../services/ai/detection.service';
import { NO_PENDING_CLOSED_ORDER_BOT_MESSAGE } from '../../../services/productQuery/botMessages';
import {
  formatBotUserMessage,
  getRequestedPartySize,
  normalizeMetadata,
} from '../../../services/productQuery/utils';
import {
  blocksOrderPartySizeForReservationDomain,
  derivePartySizeGoal,
  getPartySizeGoalLedger,
  isFoodRelatedPartySizeSignal,
} from '../../../services/partySizeGoal.service';
import { deriveOrderQuantityGoalTarget } from '../../../services/orderQuantityGoal.service';
import { ensurePendingOrderLinesFromRequest } from '../../../services/pendingOrderLines.service';
import { clearWelcomeEligible } from '../../../services/welcomeEligible.service';
import { patchConversationMetadata, findOrCreateConversationState, omitConversationMetadataKeys } from '../../../repositories';
import { isCheckoutAgentEnabled, isReservationAgentEnabled } from '../../../config/env';
import { reservationAgentNode } from '../reservation';
import { runHybridReactAgent } from '../../../agents/reactAgent';
import { buildAgentHistoryMessages } from '../../../agents/conversationHistory';
import type { HybridAgentRunResult } from '../../../agents/reactAgent';
import {
  applyHumanIntentTurnDecision,
  getHumanIntentState,
} from '../../../services/humanIntentState.service';
import { runHumanIntentPreflight } from '../../../services/humanIntentPreflight.service';
import {
  activateCheckoutSessionIfCartHasItems,
  applyDefaultFulfillmentIfSingleOption,
  resolveCheckoutAgentHandlerResult,
} from '../checkout';
import { ConversationIntent } from '../../../types/conversationIntent';
import { EditAddressHandler } from '../../../controllers/webhook/handlers/editAddressHandler';
import type {
  EnrichedContext,
  HandlerResult,
} from '../../../controllers/webhook/types';
import type { AgentState, AgentStateUpdate } from '../../state';
import { resolveDomainCancelCommand } from '../../../services/domainCancelCommand.service';
import { buildCancelOrderMessage } from '../../../services/order.service';
import { clearReservationSessionAfterCancel } from '../../../services/reservationSessionReset.service';
import { buildCartSummaryMessage } from '../../../services/cart.service';

/** Stub para EnrichedContext / CTAs que aún leen detection. El híbrido busca con tools. */
const NLP_AGENT_FIRST_DETECTION: IntentDetectionResult = {
  intent: ConversationIntent.UNKNOWN,
  confidence: 1,
  detectedProductName: null,
  quantity: null,
  quantityMode: null,
  addressText: null,
  addressConfidence: null,
  customerName: null,
  candidates: [],
  alternatives: [],
  resolutionSource: 'unknown',
  topCandidate: null,
  rescueMargin: null,
  raw: null,
};

type CheckoutHandoffParams = {
  conversationId: string;
  businessId: string;
  phone: string;
  hasAddress: boolean;
  isInCoverage: boolean;
  deliveryEnabled: boolean;
  takeawayEnabled: boolean;
};

const resolveCheckoutHandoff = async (
  enrichedCtx: EnrichedContext,
  handoff: CheckoutHandoffParams
): Promise<HandlerResult> => {
  const emptyCart = await activateCheckoutSessionIfCartHasItems({
    businessId: handoff.businessId,
    phone: handoff.phone,
    conversationId: handoff.conversationId,
  });
  if (emptyCart) {
    return emptyCart;
  }

  await applyDefaultFulfillmentIfSingleOption({
    businessId: handoff.businessId,
    phone: handoff.phone,
    deliveryEnabled: handoff.deliveryEnabled,
    takeawayEnabled: handoff.takeawayEnabled,
  });

  return resolveCheckoutAgentHandlerResult({
    enrichedCtx,
    checkoutCtx: {
      hasAddress: handoff.hasAddress,
      isInCoverage: handoff.isInCoverage,
      deliveryEnabled: handoff.deliveryEnabled,
      takeawayEnabled: handoff.takeawayEnabled,
    },
    conversationId: handoff.conversationId,
  });
};

/**
 * Abre la sesión de reservas y corre el agente en el mismo turno (señal
 * `start_reservation_session`). Es un callback porque `reservationAgentNode`
 * necesita el `AgentState` completo, no el `EnrichedContext`.
 */
type ReservationHandoff = () => Promise<HandlerResult | null>;

/** Entrada fresca al híbrido desde el atajo welcome ORDER_FOOD. */
const ORDER_FOOD_ENTRY_MESSAGE = 'Quiero hacer un pedido.';

/**
 * Payload ORDER_FOOD del welcome: no hay handler interactivo; se convierte en
 * texto libre y se despacha al híbrido (mismo patrón que la entrada fresca a
 * reservas tras cancelar carrito).
 */
const sanitizeStateForOrderFoodEntry = (
  state: AgentState,
  enrichedBase: EnrichedContext
): AgentState => {
  const entryMessage = {
    type: 'text' as const,
    text: { body: ORDER_FOOD_ENTRY_MESSAGE },
  };
  const webhookContext = {
    ...state.webhookContext!,
    payloadId: undefined,
    message: {
      ...(state.webhookContext?.message ?? {}),
      ...entryMessage,
      interactive: undefined,
    },
  };
  const enrichedCtx: EnrichedContext = {
    ...enrichedBase,
    payloadId: undefined,
    message: {
      ...(enrichedBase.message ?? {}),
      ...entryMessage,
      interactive: undefined,
    },
  };
  return {
    ...state,
    webhookContext: webhookContext as unknown as AgentState['webhookContext'],
    enrichedCtx: enrichedCtx as unknown as AgentState['enrichedCtx'],
  };
};

/** Wipe del carrito + abre reservas (confirmación tipable/botón). */
const RESERVATION_ENTRY_AFTER_ORDER_CANCEL =
  'Quiero hacer una reserva de mesa.';

/**
 * Tras confirmar cancelar el pedido para reservar, el webhook aún trae el
 * botón/tipable de confirmación ("Sí, cancelar"). Si se lo pasamos tal cual a
 * `reservationAgentNode`, H-09 lo convierte en texto huérfano y el modelo
 * llama abandon_reservation. Entrada fresca: sin payloadId, mensaje neutro.
 */
const sanitizeStateForReservationEntry = (
  state: AgentState,
  enrichedBase: EnrichedContext,
  conversationState: AgentState['workingConversationState']
): { state: AgentState; enrichedCtx: EnrichedContext } => {
  const entryMessage = {
    type: 'text' as const,
    text: { body: RESERVATION_ENTRY_AFTER_ORDER_CANCEL },
  };
  const webhookContext = {
    ...state.webhookContext!,
    payloadId: undefined,
    message: {
      ...(state.webhookContext?.message ?? {}),
      ...entryMessage,
      interactive: undefined,
    },
  };
  const enrichedCtx: EnrichedContext = {
    ...enrichedBase,
    conversationState: conversationState ?? enrichedBase.conversationState,
    payloadId: undefined,
    message: {
      ...(enrichedBase.message ?? {}),
      ...entryMessage,
      interactive: undefined,
    },
  };
  return {
    state: {
      ...state,
      webhookContext: webhookContext as unknown as AgentState['webhookContext'],
      workingConversationState: conversationState,
      enrichedCtx: enrichedCtx as unknown as AgentState['enrichedCtx'],
    },
    enrichedCtx,
  };
};

const openReservationAfterCartCancel = async (
  state: AgentState,
  workingConversationState: AgentState['workingConversationState'],
  enrichedBase: EnrichedContext
): Promise<{ handlerResult: HandlerResult; workingConversationState: AgentState['workingConversationState'] }> => {
  const conversation = state.conversation!;
  const business = state.business!;
  const customer = state.customer!;
  const phone =
    customer.phone_number ?? state.webhookContext?.to ?? '';

  await applySwitchToReservationConfirm({
    conversation,
    businessId: business.id,
    customerPhone: phone,
  });

  const { clearWelcomeEligible } = await import(
    '../../../services/welcomeEligible.service'
  );
  await clearWelcomeEligible(conversation.id).catch(() => undefined);

  const refreshed = await findOrCreateConversationState(conversation.id);
  if (!isReservationAgentEnabled()) {
    return {
      handlerResult: {
        content: formatBotUserMessage(
          'Pedido cancelado',
          '❌',
          'Cancelamos tu pedido. Las reservas no están disponibles ahora; pedime el menú cuando quieras armar uno nuevo.'
        ),
        isInteractive: false,
        skipBodyHumanization: true,
      },
      workingConversationState: refreshed,
    };
  }

  const { state: entryState } = sanitizeStateForReservationEntry(
    state,
    enrichedBase,
    refreshed
  );
  console.debug(
    JSON.stringify({
      event: '[switch-to-reservation] open_reservation_fresh_entry',
      conversationId: conversation.id,
    })
  );
  const update = await reservationAgentNode(entryState);

  return {
    handlerResult: update.handlerResult ?? {
      content: formatBotUserMessage(
        'Reserva',
        '📅',
        'Listo, cancelamos el pedido. ¿Para cuántas personas y qué día querés la mesa?'
      ),
      isInteractive: false,
      skipBodyHumanization: true,
    },
    workingConversationState: refreshed,
  };
};

const resolveAddressEditHandoff = async (
  enrichedCtx: EnrichedContext
): Promise<HandlerResult | null> => {
  const result = await new EditAddressHandler().execute(enrichedCtx);
  console.debug(
    JSON.stringify({
      event: '[nlp] delegate_address_edit',
      conversationId: enrichedCtx.conversation?.id,
    })
  );
  return result;
};

const unwrapHybridRun = async (
  hybrid: HybridAgentRunResult | null,
  enrichedCtx: EnrichedContext,
  checkoutHandoff?: CheckoutHandoffParams,
  reservationHandoff?: ReservationHandoff
): Promise<HandlerResult | null> => {
  if (!hybrid) return null;
  if (
    hybrid.kind === 'delegate_checkout' &&
    checkoutHandoff &&
    isCheckoutAgentEnabled()
  ) {
    return resolveCheckoutHandoff(enrichedCtx, checkoutHandoff);
  }
  if (hybrid.kind === 'delegate_reservation') {
    if (reservationHandoff && isReservationAgentEnabled()) {
      return reservationHandoff();
    }
    // Sin handoff disponible (delegación desde una sesión, o agente apagado):
    // no encadenamos la reserva en este turno, igual que delegate_checkout.
    console.warn(
      JSON.stringify({
        event: '[nlp] delegate_reservation_unhandled',
        conversationId: enrichedCtx.conversation?.id,
      })
    );
    return null;
  }
  if (hybrid.kind === 'delegate_address_edit') {
    return resolveAddressEditHandoff(enrichedCtx);
  }
  if (hybrid.kind === 'response') {
    return hybrid.handlerResult;
  }
  return null;
};

const isOpenAiRateLimitError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as {
    status?: number;
    lc_error_code?: string;
    code?: string;
    message?: string;
  };
  if (e.status === 429 || e.lc_error_code === 'MODEL_RATE_LIMIT') return true;
  if (e.code === 'rate_limit_exceeded') return true;
  return typeof e.message === 'string' && /rate.?limit/i.test(e.message);
};

const readActiveCartFingerprint = async (params: {
  businessId: string;
  customerPhone: string;
}): Promise<string | null> => {
  try {
    const draft = await prisma.draft_order.findFirst({
      where: {
        business_id: params.businessId,
        customer_phone: params.customerPhone,
        status: 'active',
      },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        draft_order_item: {
          orderBy: { id: 'asc' },
          select: { id: true, product_id: true, quantity: true, variation: true, notes: true },
        },
      },
    });
    if (!draft) return null;
    return JSON.stringify({
      id: draft.id,
      items: draft.draft_order_item,
    });
  } catch {
    return null;
  }
};

const buildPostEffectCartResult = async (
  enrichedCtx: EnrichedContext
): Promise<HandlerResult | null> => {
  const business = enrichedCtx.business as { id?: string; currency_code?: string | null; street_address?: string | null } | null;
  const customer = enrichedCtx.customer as { id?: string; phone_number?: string | null } | null;
  if (!business?.id || !customer?.id) return null;
  const customerPhone = customer.phone_number ?? enrichedCtx.to;
  try {
    const cart = await buildCartSummaryMessage({
      businessId: business.id,
      customerPhone,
      conversationId: enrichedCtx.conversationId,
      customerId: customer.id,
      currencyCode: business.currency_code ?? null,
      businessStreetAddress: business.street_address ?? null,
      llmProse: null,
    });
    return {
      content: cart,
      isInteractive: true,
      skipBodyHumanization: true,
    };
  } catch (error) {
    console.error('[nlp] post-effect cart recovery failed:', error);
    return null;
  }
};

const dispatchOrHybrid = async (
  enrichedCtx: EnrichedContext,
  checkoutHandoff?: CheckoutHandoffParams,
  reservationHandoff?: ReservationHandoff,
  allowLegacyFallback = true
): Promise<HandlerResult | null> => {
  const cartBefore = await readActiveCartFingerprint({
    businessId: enrichedCtx.business?.id ?? '',
    customerPhone: enrichedCtx.customer?.phone_number ?? enrichedCtx.to,
  });
  let hybridError: unknown = null;
  try {
    const hybrid = await runHybridReactAgent(enrichedCtx);
    console.log(JSON.stringify({
      event: '[react]',
      turnId: enrichedCtx.turnId,
      kind: hybrid?.kind ?? null,
    }));
    const result = await unwrapHybridRun(
      hybrid,
      enrichedCtx,
      checkoutHandoff,
      reservationHandoff
    );
    if (result) {
      console.log(JSON.stringify({
        event: '[response]',
        turnId: enrichedCtx.turnId,
        kind: hybrid?.kind === 'response' ? 'react' : hybrid?.kind,
      }));
      return result;
    }
  } catch (err) {
    hybridError = err;
    console.error('[error]', JSON.stringify({
      event: 'hybrid_react_failed',
      turnId: enrichedCtx.turnId,
      message: err instanceof Error ? err.message : String(err),
    }));
  }

  const cartAfter = await readActiveCartFingerprint({
    businessId: enrichedCtx.business?.id ?? '',
    customerPhone: enrichedCtx.customer?.phone_number ?? enrichedCtx.to,
  });
  if (cartBefore !== cartAfter) {
    const postEffectResult = await buildPostEffectCartResult(enrichedCtx);
    if (postEffectResult) {
      console.log(JSON.stringify({
        event: '[response]',
        turnId: enrichedCtx.turnId,
        kind: 'post_effect',
      }));
      return postEffectResult;
    }
    return {
      content: formatBotUserMessage(
        'No pude confirmar el pedido',
        '⚠️',
        'Tuve un problema al consultar el estado actualizado del pedido. ¿Me das un momento y lo reviso?'
      ),
      isInteractive: false,
      skipBodyHumanization: true,
    };
  }

  if (hybridError && isOpenAiRateLimitError(hybridError)) {
    return {
      content: formatBotUserMessage(
        'Un momento',
        '⏳',
        'Estoy un poco demorado. ¿Me reenviás el mensaje en unos segundos?'
      ),
      isInteractive: false,
    };
  }
  if (!allowLegacyFallback) return null;
  const fallbackResult = await dispatchIntent(enrichedCtx);
  if (fallbackResult) {
    console.log(JSON.stringify({
      event: '[response]',
      turnId: enrichedCtx.turnId,
      kind: 'fallback',
    }));
  }
  return fallbackResult;
};

const humanIntentClarificationResult = (): HandlerResult => ({
  content: formatBotUserMessage(
    'Una aclaración',
    '🤔',
    'No me quedó claro qué querés hacer. ¿Querés continuar con la tarea actual o empezar otra?'
  ),
  isInteractive: false,
  skipBodyHumanization: true,
});

const asPreflightTurn = (
  message: { getType?: () => string; content?: unknown }
): { role: 'user' | 'assistant'; text: string } | null => {
  const role = message.getType?.();
  if (role !== 'human' && role !== 'ai') return null;
  const text = typeof message.content === 'string'
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .map((part) =>
            typeof part === 'object' && part !== null && 'text' in part
              ? String((part as { text?: unknown }).text ?? '')
              : ''
          )
          .join('')
      : '';
  if (!text.trim()) return null;
  return { role: role === 'human' ? 'user' : 'assistant', text: text.trim() };
};

const loadVisibleProductReferences = async (
  metadata: unknown,
  businessId: string
): Promise<Array<{ id: string; kind: 'product'; label: string }>> => {
  const meta = normalizeMetadata(metadata);
  if (typeof meta.lastCtaShownAt !== 'string') return [];
  const ids = [
    ...(meta.pendingProductSelection && Array.isArray(meta.candidateProductIds)
      ? meta.candidateProductIds
      : []),
    ...(typeof meta.lastCtaShownAt === 'string' && typeof meta.lastCtaProductId === 'string'
      ? [meta.lastCtaProductId]
      : []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const uniqueIds = [...new Set(ids)].slice(0, 12);
  if (uniqueIds.length === 0) return [];
  try {
    const rows = await prisma.menu_item.findMany({
      where: { id: { in: uniqueIds }, business_id: businessId },
      select: { id: true, name: true },
    });
    const byId = new Map(rows.map((row) => [row.id, row.name]));
    return uniqueIds.flatMap((id) => {
      const label = byId.get(id);
      return label ? [{ id, kind: 'product' as const, label }] : [];
    });
  } catch (error) {
    console.error('[human-intent-preflight] visible references unavailable:', error);
    return [];
  }
};

/**
 * Subgrafo interactive: limpieza de metadata `CONFIRM_INTENT:*` + dispatch.
 * Fase 2: log `cta_clicked` cuando el payload coincide con el último CTA mostrado.
 */
export const interactiveSubgraphNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const enrichedBase = state.enrichedCtx as unknown as EnrichedContext;
  const conversation = state.conversation!;

  // Fase 2: correlacionar click con el último CTA mostrado
  if (ctx.payloadId && enrichedBase.conversationState) {
    const meta = normalizeMetadata(enrichedBase.conversationState.metadata);
    if (meta.lastCtaPayload && ctx.payloadId === meta.lastCtaPayload) {
      console.log(
        JSON.stringify({
          event: '[hybrid-cta] cta_clicked',
          payloadId: ctx.payloadId,
          lastCtaProductId: meta.lastCtaProductId ?? null,
          conversationId: conversation.id,
        })
      );
    }
  }

  // Gate: híbrido → reserva con carrito activo (botones §3.11)
  if (ctx.payloadId === CONFIRM_CANCEL_ORDER_FOR_RESERVATION_PAYLOAD) {
    const pending = getPendingSwitchToReservation(
      enrichedBase.conversationState?.metadata
    );
    if (!pending) {
      return {
        handlerResult: {
          content: formatBotUserMessage(
            'Sin pendiente',
            'ℹ️',
            'No hay una confirmación de reserva pendiente. Si querés reservar, decime y te ayudo.'
          ),
          isInteractive: false,
          skipBodyHumanization: true,
        },
      };
    }
    const opened = await openReservationAfterCartCancel(
      state,
      state.workingConversationState,
      enrichedBase
    );
    return {
      handlerResult: opened.handlerResult,
      workingConversationState: opened.workingConversationState,
    };
  }

  if (ctx.payloadId === DECLINE_SWITCH_TO_RESERVATION_PAYLOAD) {
    return {
      handlerResult: await applySwitchToReservationDecline(conversation.id),
    };
  }

  // Welcome "Hacer un pedido": sin handler de botón → texto fresco + NLP/híbrido.
  if (ctx.payloadId === 'ORDER_FOOD') {
    console.log(
      JSON.stringify({
        event: '[interactive] order_food_to_nlp',
        conversationId: conversation.id,
      })
    );
    return nlpSubgraphNode(sanitizeStateForOrderFoodEntry(state, enrichedBase));
  }

  // Gate de pedidos en horario cerrado
  if (state.businessClosedButOperating && ctx.payloadId) {
    const businessConfig = state.businessConfig;
    const ordersWhenClosed = businessConfig?.orders_when_closed ?? false;
    const payloadId = ctx.payloadId;
    const alreadyConfirmedClosedOrder = Boolean(
      normalizeMetadata(enrichedBase.conversationState?.metadata).closed_order_confirmed_at
    );

    if (payloadId.startsWith('ADD_ITEM:')) {
      if (!ordersWhenClosed) {
        return {
          handlerResult: {
            content: '🤖\n\n*Estamos cerrados.* ❌\n\nLos pedidos no están disponibles fuera del horario de atención. ¡Te esperamos pronto!',
            isInteractive: false,
          },
        };
      }

      // D5 — el cliente ya aceptó pedir fuera de horario en esta conversación:
      // no volver a preguntar, dejar pasar directo al dispatch normal.
      if (alreadyConfirmedClosedOrder) {
        const result = await dispatchInteractive(enrichedBase);
        if (!result) {
          return { earlyExit: 'interactive_no_payload' };
        }
        return { handlerResult: result };
      }

      // D4/D7 — variación y cantidad ANTES del confirm de cerrado: el add
      // debe estar definido (producto + variación + qty) para no re-preguntar.
      const { productId, variationIndex, quantityFromPayload } =
        parseAddItemButtonPayload(payloadId);
      if (productId) {
        const item = await prisma.menu_item.findFirst({
          where: { id: productId, business_id: state.business!.id },
          select: { variations: true, serves_people: true },
        });
        if (item && hasVariations(item) && variationIndex == null) {
          const result = await dispatchInteractive(enrichedBase);
          if (!result) {
            return { earlyExit: 'interactive_no_payload' };
          }
          return { handlerResult: result };
        }
        const partySize = getRequestedPartySize(
          normalizeMetadata(enrichedBase.conversationState?.metadata)
        );
        const { suggestedQuantity } = suggestAddQuantity({
          partySize,
          servesPeople: item?.serves_people,
        });
        // Solo diferir el confirm de cerrado si realmente hay que preguntar cantidad.
        if (
          needsAddQuantityConfirmation({ suggestedQuantity, partySize }) &&
          !isConfirmedAddQuantity({
            quantity: quantityFromPayload,
            suggestedQuantity,
          })
        ) {
          const result = await dispatchInteractive(enrichedBase);
          if (!result) {
            return { earlyExit: 'interactive_no_payload' };
          }
          return { handlerResult: result };
        }
      }

      // orders_when_closed=true → pedir confirmación explícita
      await patchConversationMetadata(conversation.id, { pending_closed_add_item: payloadId });
      const confirmation = buildClosedOrderConfirmationMessage(state.businessStatus?.nextOpenText ?? null);
      return { handlerResult: { content: confirmation, isInteractive: true } };
    }

    if (ordersWhenClosed && payloadId === CONFIRM_CLOSED_ORDER) {
      const meta = normalizeMetadata(enrichedBase.conversationState?.metadata);
      const pending = meta.pending_closed_add_item;
      if (!pending) {
        return { handlerResult: { content: NO_PENDING_CLOSED_ORDER_BOT_MESSAGE, isInteractive: false } };
      }
      const pendingResult = await applyClosedOrderConfirm(
        conversation.id,
        enrichedBase,
        pending
      );
      if (!pendingResult) {
        return { earlyExit: 'interactive_no_payload' };
      }
      return { handlerResult: pendingResult };
    }

    if (ordersWhenClosed && payloadId === CANCEL_CLOSED_ORDER) {
      return {
        handlerResult: await applyClosedOrderCancel(conversation.id),
      };
    }
  }

  const result = await dispatchInteractive(enrichedBase);
  if (!result) {
    return { earlyExit: 'interactive_no_payload' };
  }

  const isHumanHandover = ctx.payloadId === ConversationIntent.SUPPORT;
  return { handlerResult: result, isHumanHandover };
};

/**
 * Subgrafo NLP: texto libre → ReAct híbrido. Sin clasificador de intent.
 * Ownership de sesión y botones no pasan por acá.
 */
export const nlpSubgraphNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const enrichedBase = state.enrichedCtx as unknown as EnrichedContext;
  const conversation = state.conversation!;
  let workingConversationState = state.workingConversationState;
  const business = state.business!;
  const customer = state.customer!;
  let allowLegacyFallback = true;

  console.debug(
    JSON.stringify({
      event: '[nlp] agent_first',
      nlp_agent_first: true,
      conversationId: conversation.id,
    })
  );

  const checkoutHandoff: CheckoutHandoffParams | undefined = isCheckoutAgentEnabled()
    ? {
        conversationId: conversation.id,
        businessId: business.id,
        phone: customer.phone_number ?? ctx.to,
        hasAddress: state.hasAddress ?? false,
        isInCoverage: state.isInCoverage ?? false,
        deliveryEnabled:
          (state.businessConfig?.delivery_enabled ?? true) ||
          (state.businessConfig?.external_delivery_enabled ?? false),
        takeawayEnabled: state.businessConfig?.takeaway_enabled ?? false,
      }
    : undefined;

  const userMessage = ctx.message?.text?.body || '';
  console.log(JSON.stringify({
    event: '[turn]',
    turnId: ctx.turnId,
    conversationId: conversation.id,
    user: userMessage.slice(0, 80),
  }));
  const metadataBeforePreflight = normalizeMetadata(
    workingConversationState?.metadata ?? enrichedBase.conversationState?.metadata
  );
  const preflightOwnedByPendingGate =
    (userMessage.trim() && Boolean(getPendingSwitchToReservation(metadataBeforePreflight))) ||
    Boolean(
      userMessage.trim() &&
      state.businessClosedButOperating &&
      state.businessConfig?.orders_when_closed &&
      metadataBeforePreflight.pending_closed_add_item
    );

  if (userMessage.trim() && !preflightOwnedByPendingGate) {
    const messageId = typeof ctx.message?.id === 'string' ? ctx.message.id.trim() : '';
    if (!messageId) {
      return {
        handlerResult: humanIntentClarificationResult(),
        detection: NLP_AGENT_FIRST_DETECTION,
        dataCollectionDelegated: true,
      };
    }

    try {
      const freshConversationState = await findOrCreateConversationState(conversation.id);
      const intentState = await getHumanIntentState(conversation.id);
      const history = await buildAgentHistoryMessages({
        conversationId: conversation.id,
        startedAt:
          typeof conversation.started_at === 'object'
            ? conversation.started_at
            : null,
        currentMessageId: messageId,
        limit: 6,
      });
      const recentTurns = history
        .map(asPreflightTurn)
        .filter((turn): turn is NonNullable<typeof turn> => turn !== null);
      const lastAssistantQuestion = [...recentTurns]
        .reverse()
        .find((turn) => turn.role === 'assistant')?.text;
      const visibleReferences = await loadVisibleProductReferences(
        freshConversationState.metadata,
        business.id
      );
      const active = intentState.records.find((intent) => intent.status === 'ACTIVE') ?? null;
      const pending = intentState.records
        .filter((intent) => intent.status === 'PENDING')
        .sort((a, b) => a.sequence - b.sequence);
      const partySizeGoalActive = derivePartySizeGoal(
        {
          partySize: getRequestedPartySize(metadataBeforePreflight) ?? null,
          foodRelatedSignal:
            active?.goal === 'PEDIR' ||
            isFoodRelatedPartySizeSignal({
              metadata: metadataBeforePreflight,
              lastReferencedProductId:
                (conversation as { lastReferencedProductId?: string | null })
                  .lastReferencedProductId ?? null,
            }),
          checkoutActive: metadataBeforePreflight.checkout_active === true,
          reservationDomainActive: blocksOrderPartySizeForReservationDomain(
            metadataBeforePreflight
          ),
        },
        getPartySizeGoalLedger(metadataBeforePreflight)
      ).open;
      const quantityGoalActive = !partySizeGoalActive && active?.goal === 'PEDIR' && Boolean(
        deriveOrderQuantityGoalTarget({
          activePedir: true,
          checkoutActive: metadataBeforePreflight.checkout_active === true,
          partySizeKnown: getRequestedPartySize(metadataBeforePreflight) != null,
          metadata: metadataBeforePreflight,
        })
      );
      const activeBlockingGoal = partySizeGoalActive
        ? 'OBTENER_PERSONAS_DEL_PEDIDO'
        : quantityGoalActive
          ? 'OBTENER_CANTIDAD_DEL_PRODUCTO'
          : undefined;
      if (activeBlockingGoal) enrichedBase.activeBlockingGoal = activeBlockingGoal;
      const decision = await runHumanIntentPreflight({
        turn: { messageId, text: userMessage },
        context: {
          recentTurns,
          ...(lastAssistantQuestion ? { lastAssistantQuestion } : {}),
          visibleReferences,
          ...(activeBlockingGoal ? { activeBlockingGoal } : {}),
        },
        state: { revision: intentState.revision, active, pending },
      });
      console.log(JSON.stringify({
        event: '[preflight]',
        turnId: ctx.turnId,
        decision: decision.decision,
        active: active?.goal ?? null,
        pending: pending.length,
      }));
      console.log(JSON.stringify({
        event: '[intent]',
        turnId: ctx.turnId,
        active: active?.goal ?? null,
        intentId: active?.id ?? null,
      }));

      if (decision.decision === 'AMBIGUOUS') {
        if (!partySizeGoalActive) {
          console.log(
            JSON.stringify({ event: '[human-intent-preflight] ambiguous', conversationId: conversation.id })
          );
          return {
            handlerResult: humanIntentClarificationResult(),
            detection: NLP_AGENT_FIRST_DETECTION,
            dataCollectionDelegated: true,
          };
        }
        allowLegacyFallback = false;
      } else if (decision.decision === 'NO_INTENT') {
        allowLegacyFallback = true;
      } else {
        const applied = await applyHumanIntentTurnDecision({
          conversationId: conversation.id,
          messageId,
          expectedRevision: intentState.revision,
          decision,
        });
        if (applied.status === 'duplicate') return { skipAIPersistence: true };
        if (applied.status !== 'applied') {
          console.log(
            JSON.stringify({
              event: '[human-intent-preflight] transition_rejected',
              status: applied.status,
              conversationId: conversation.id,
            })
          );
          return {
            handlerResult: humanIntentClarificationResult(),
            detection: NLP_AGENT_FIRST_DETECTION,
            dataCollectionDelegated: true,
          };
        }

        workingConversationState = await findOrCreateConversationState(conversation.id);
        enrichedBase.conversationState = workingConversationState;
        enrichedBase.humanIntentGateRevision = applied.state.revision;
        const activePedir = applied.state.records.find(
          (intent) => intent.goal === 'PEDIR' && intent.status === 'ACTIVE'
        );
        if (activePedir) {
          await clearWelcomeEligible(conversation.id);
          await ensurePendingOrderLinesFromRequest({
            conversationId: conversation.id,
            request: activePedir.request,
            sourceMessage: userMessage,
            metadata: workingConversationState.metadata,
          });
          workingConversationState = await findOrCreateConversationState(conversation.id);
          enrichedBase.conversationState = workingConversationState;
        }
        const fulfillmentCandidate =
          decision.decision === 'CONTINUE_ACTIVE'
            ? decision.fulfillmentCandidate
            : undefined;
        if (fulfillmentCandidate) {
          enrichedBase.goalFulfillmentCandidate = fulfillmentCandidate;
        }
        allowLegacyFallback = false;
        console.log(
          JSON.stringify({
            event: '[human-intent-preflight] applied',
            decision: decision.decision,
            conversationId: conversation.id,
            revision: applied.state.revision,
          })
        );
      }
    } catch (error) {
      console.error('[human-intent-preflight] failed closed:', error);
      return {
        handlerResult: humanIntentClarificationResult(),
        detection: NLP_AGENT_FIRST_DETECTION,
        dataCollectionDelegated: true,
      };
    }
  }

  if (userMessage.trim() && enrichedBase.conversationState) {
    const meta = normalizeMetadata(enrichedBase.conversationState.metadata);
    if (meta.lastCtaPayload && meta.lastCtaShownAt) {
      console.log(
        JSON.stringify({
          event: '[hybrid-cta] cta_fallback_post_click',
          lastCtaPayload: meta.lastCtaPayload,
          lastCtaProductId: meta.lastCtaProductId ?? null,
          conversationId: conversation.id,
        })
      );
    }
  }

  const metaPre = normalizeMetadata(workingConversationState?.metadata);

  // Gate tipable: cancelar pedido para pasar a reserva (§3.11 — mismo efecto que botones).
  // Un pending sin ítems es fuga de estado: se limpia y el turno sigue al híbrido.
  if (getPendingSwitchToReservation(metaPre) && userMessage.trim()) {
    const cartItems = await countActiveCartItems({
      businessId: business.id,
      customerPhone: customer.phone_number ?? ctx.to ?? '',
    });
    if (cartItems === 0) {
      await clearPendingSwitchToReservation(conversation.id);
      const dropPending = (row: { metadata?: unknown } | null | undefined): void => {
        const metadata = row?.metadata;
        if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
          delete (metadata as Record<string, unknown>).pending_switch_to_reservation;
        }
      };
      dropPending(workingConversationState);
      dropPending(enrichedBase.conversationState);
      console.log(
        JSON.stringify({
          event: '[switch-to-reservation] stale_pending_cleared',
          conversationId: conversation.id,
        })
      );
    } else {
      const extraction = await extractSwitchToReservationPending(userMessage);
      console.log(
        JSON.stringify({
          event: '[switch-to-reservation] confirm_tipable_extraction',
          status: extraction.status,
          confidence: extraction.confidence,
          source: extraction.source,
          conversationId: conversation.id,
        })
      );

      if (extraction.status === 'fulfilled' && extraction.value) {
        if (extraction.value.confirmed) {
          const opened = await openReservationAfterCartCancel(
            state,
            workingConversationState,
            enrichedBase
          );
          return {
            handlerResult: opened.handlerResult,
            workingConversationState: opened.workingConversationState,
          };
        }
        return {
          handlerResult: await applySwitchToReservationDecline(conversation.id),
        };
      }

      return {
        handlerResult: {
          content: buildSwitchToReservationConfirmMessage(),
          isInteractive: true,
          skipBodyHumanization: true,
        },
      };
    }
  }

  // Gate tipable: confirmación de pedido con negocio cerrado (§3.11 — mismo efecto que botones)
  if (
    state.businessClosedButOperating &&
    state.businessConfig?.orders_when_closed &&
    metaPre.pending_closed_add_item &&
    userMessage.trim()
  ) {
    const pending = metaPre.pending_closed_add_item;
    const extraction = await extractConfirmClosedOrderPending(userMessage);
    console.log(
      JSON.stringify({
        event: '[closed-order] confirm_tipable_extraction',
        status: extraction.status,
        confidence: extraction.confidence,
        source: extraction.source,
        conversationId: conversation.id,
      })
    );

    if (extraction.status === 'fulfilled' && extraction.value) {
      if (extraction.value.confirmed) {
        const pendingResult = await applyClosedOrderConfirm(
          conversation.id,
          enrichedBase,
          pending
        );
        if (!pendingResult) {
          return { earlyExit: 'interactive_no_payload' };
        }
        return { handlerResult: pendingResult };
      }
      return {
        handlerResult: await applyClosedOrderCancel(conversation.id),
      };
    }

    // reprompt / delegate / off_pending: re-mostrar botones (no consumir pending)
    const confirmation = buildClosedOrderConfirmationMessage(
      state.businessStatus?.nextOpenText ?? null
    );
    return { handlerResult: { content: confirmation, isInteractive: true } };
  }

  const domainCancel = resolveDomainCancelCommand({
    payloadId: ctx.payloadId,
    userMessage,
  });
  if (domainCancel === 'reservation') {
    await clearReservationSessionAfterCancel(conversation.id);
    console.log(
      JSON.stringify({
        event: '[nlp] domain_cancel_reservation',
        conversationId: conversation.id,
      })
    );
    return {
      handlerResult: {
        content: formatBotUserMessage(
          'Reserva cancelada',
          '❌',
          'Si en algún momento querés hacer una nueva reserva, avisame.'
        ),
        isInteractive: false,
        skipBodyHumanization: true,
      },
    };
  }
  if (domainCancel === 'order') {
    const result = await buildCancelOrderMessage(
      conversation,
      business.id,
      customer.phone_number ?? ctx.to
    );
    if (result) {
      console.log(
        JSON.stringify({
          event: '[nlp] domain_cancel_order',
          conversationId: conversation.id,
        })
      );
      return {
        handlerResult:
          typeof result === 'string'
            ? { content: result, isInteractive: false, skipBodyHumanization: true }
            : { content: result, isInteractive: true, skipBodyHumanization: true },
      };
    }
  }

  const detection = NLP_AGENT_FIRST_DETECTION;

  const enrichedCtx: EnrichedContext = {
    ...enrichedBase,
    conversationState: workingConversationState ?? enrichedBase.conversationState,
    detection,
    hasAddress: state.hasAddress,
    isInCoverage: state.isInCoverage,
  };

  // Reserva en prosa: el nodo de reservas activa la sesión y contesta en este
  // mismo turno. Desde el próximo, Ownership lo rutea directo (contextRoute).
  let reservationDelegated = false;
  const reservationHandoff: ReservationHandoff | undefined = isReservationAgentEnabled()
    ? async () => {
        reservationDelegated = true;
        const update = await reservationAgentNode({
          ...state,
          workingConversationState,
          enrichedCtx: enrichedCtx as unknown as AgentState['enrichedCtx'],
        });
        return update.handlerResult ?? null;
      }
    : undefined;

  const result = await dispatchOrHybrid(
    enrichedCtx,
    checkoutHandoff,
    reservationHandoff,
    allowLegacyFallback
  );
  if (checkoutHandoff || reservationDelegated) {
    workingConversationState = await findOrCreateConversationState(conversation.id);
  }
  if (!result) {
    return { detection, earlyExit: 'no_handler_match' };
  }

  return {
    handlerResult: result,
    detection,
    isHumanHandover: false,
    dataCollectionDelegated: true,
    workingConversationState,
  };
};
