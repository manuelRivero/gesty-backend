/**
 * Subgrafos `interactive` y `nlp`.
 *
 * Interactive: payloads de botón → mapper + handlers (sin ReAct).
 * NLP (texto libre, sin Ownership de sesión): un solo camino ReAct híbrido.
 * Sin clasificador de intent. Fallback a `dispatchIntent` solo si el agente
 * explota / 429.
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
import type { IntentDetectionResult } from '../../../services/ai/detection.service';
import {
  CLOSED_ORDER_CANCELLED_BOT_MESSAGE,
  NO_PENDING_CLOSED_ORDER_BOT_MESSAGE,
} from '../../../services/productQuery/botMessages';
import {
  formatBotUserMessage,
  getRequestedPartySize,
  normalizeMetadata,
} from '../../../services/productQuery/utils';
import { patchConversationMetadata, findOrCreateConversationState, omitConversationMetadataKeys } from '../../../repositories';
import { isCheckoutAgentEnabled, isReservationAgentEnabled } from '../../../config/env';
import { reservationAgentNode } from '../reservation';
import { runHybridReactAgent } from '../../../agents/reactAgent';
import type { HybridAgentRunResult } from '../../../agents/reactAgent';
import {
  activateCheckoutSessionIfCartHasItems,
  applyDefaultFulfillmentIfSingleOption,
  resolveCheckoutAgentHandlerResult,
} from '../checkout';
import { ConversationIntent } from '../../../types/conversationIntent';
import type {
  EnrichedContext,
  HandlerResult,
} from '../../../controllers/webhook/types';
import type { AgentState, AgentStateUpdate } from '../../state';

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

const dispatchOrHybrid = async (
  enrichedCtx: EnrichedContext,
  checkoutHandoff?: CheckoutHandoffParams,
  reservationHandoff?: ReservationHandoff
): Promise<HandlerResult | null> => {
  try {
    const hybrid = await runHybridReactAgent(enrichedCtx);
    console.log(
      JSON.stringify({
        event: '[nlp] agent_first_react',
        nlp_agent_first: true,
        conversationId: enrichedCtx.conversation?.id,
        hybrid_kind: hybrid?.kind ?? null,
        checkout_delegated: hybrid?.kind === 'delegate_checkout',
        reservation_delegated: hybrid?.kind === 'delegate_reservation',
      })
    );
    const result = await unwrapHybridRun(
      hybrid,
      enrichedCtx,
      checkoutHandoff,
      reservationHandoff
    );
    if (result) return result;
  } catch (err) {
    console.error('[hybrid-agent] failed, falling back to dispatchIntent', err);
    if (isOpenAiRateLimitError(err)) {
      return {
        content: formatBotUserMessage(
          'Un momento',
          '⏳',
          'Estoy un poco demorado. ¿Me reenviás el mensaje en unos segundos?'
        ),
        isInteractive: false,
      };
    }
  }
  return dispatchIntent(enrichedCtx);
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

  if (ctx.payloadId?.startsWith('CONFIRM_INTENT:')) {
    await omitConversationMetadataKeys(conversation.id, [
      'awaitingIntentConfirmation',
      'intentCandidates',
    ]);
  }

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
      await patchConversationMetadata(conversation.id, {
        closed_order_confirmed_at: new Date().toISOString(),
      });
      await omitConversationMetadataKeys(conversation.id, ['pending_closed_add_item']);
      const pendingCtx = { ...enrichedBase, payloadId: pending } as unknown as EnrichedContext;
      const pendingResult = await dispatchInteractive(pendingCtx);
      if (!pendingResult) {
        return { earlyExit: 'interactive_no_payload' };
      }
      return { handlerResult: pendingResult };
    }

    if (ordersWhenClosed && payloadId === CANCEL_CLOSED_ORDER) {
      await omitConversationMetadataKeys(conversation.id, ['pending_closed_add_item']);
      return { handlerResult: { content: CLOSED_ORDER_CANCELLED_BOT_MESSAGE, isInteractive: false } };
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

  console.log(
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

  if (
    normalizeMetadata(workingConversationState?.metadata)
      .awaitingIntentConfirmation &&
    userMessage.trim()
  ) {
    await omitConversationMetadataKeys(conversation.id, [
      'awaitingIntentConfirmation',
      'intentCandidates',
    ]);
    workingConversationState = await findOrCreateConversationState(
      conversation.id
    );
  }

  const metaPre = normalizeMetadata(workingConversationState?.metadata);

  // Gate de confirmación de pedido cuando el negocio está cerrado pero opera (NLP)
  if (state.businessClosedButOperating && state.businessConfig?.orders_when_closed && metaPre.pending_closed_add_item) {
    const pending = metaPre.pending_closed_add_item;
    const isAffirmative = /^(sí|si|s[ií]|confirmar?|dale|ok|yes|bueno|sip|vamos|correcto|claro|perfecto|obvio|quiero|confirmo|afirmo)$/i.test(userMessage.trim());
    const isNegative = /^(no|nop|nope|cancelar?|mejor no|no gracias|not|negativo|cancelo)$/i.test(userMessage.trim());

    if (isAffirmative) {
      await patchConversationMetadata(conversation.id, {
        closed_order_confirmed_at: new Date().toISOString(),
      });
      await omitConversationMetadataKeys(conversation.id, ['pending_closed_add_item']);
      const pendingCtx = { ...enrichedBase, payloadId: pending } as unknown as EnrichedContext;
      const pendingResult = await dispatchInteractive(pendingCtx);
      if (pendingResult) return { handlerResult: pendingResult };
    } else if (isNegative) {
      await omitConversationMetadataKeys(conversation.id, ['pending_closed_add_item']);
      return { handlerResult: { content: CLOSED_ORDER_CANCELLED_BOT_MESSAGE, isInteractive: false } };
    } else {
      const confirmation = buildClosedOrderConfirmationMessage(state.businessStatus?.nextOpenText ?? null);
      return { handlerResult: { content: confirmation, isInteractive: true } };
    }
  }

  if (metaPre.awaitingPartySize || metaPre.awaitingPeopleCount) {
    await omitConversationMetadataKeys(conversation.id, [
      'awaitingPartySize',
      'awaitingPeopleCount',
      'peopleCountResume',
    ]);
    workingConversationState = await findOrCreateConversationState(
      conversation.id
    );
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

  const result = await dispatchOrHybrid(enrichedCtx, checkoutHandoff, reservationHandoff);
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
