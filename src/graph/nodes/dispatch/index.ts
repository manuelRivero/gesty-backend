/**
 * Subgrafos `interactive` y `nlp` colapsados en dos nodos LangGraph que
 * replican 1:1 el flujo del orquestador original.
 *
 * Decisión de diseño: en vez de descomponer cada `IntentHandler` en su propio
 * nodo LangGraph (35+ nodos triviales con edges idénticos), reusamos los
 * dispatchers actuales (`dispatchInteractive`, `dispatchIntent`) y la lista
 * `handlers` exportada por `controllers/webhook/handlers/index.ts`. Cada
 * handler sigue siendo la "unidad de ejecución" del bot — el grafo solo
 * orquesta el routing previo (gates, NLP, gates de people-count) y posterior
 * (envío + persistencia AI).
 */

import { dispatchIntent, dispatchInteractive } from '../../../controllers/webhook/dispachers';
import { parseAddItemButtonPayload } from '../../../controllers/webhook/utils';
import { prisma } from '../../../lib/prisma';
import { hasVariations } from '../../../services/menu/menuItemVariations';
import { findActiveEnvironmentsByBusinessId } from '../../../repositories/reservation.repository';
import { buildListMessageFromButtons } from '../../../whatsappBuilders';
import { runReservationAgent } from '../../../agents/reservationAgent';
import { normalizeDate as normReservationDate } from '../../../services/reservations/utils';
import { fetchReservationSlotsForBusinessDate } from '../../../repositories/reservation.repository';
import {
  CONFIRM_CLOSED_ORDER,
  CANCEL_CLOSED_ORDER,
  buildClosedOrderConfirmationMessage,
} from '../../../services/businessHours.service';
import {
  detectIntentWithConfidence,
  shouldAskIntentConfirmation,
} from '../../../services/ai/detection.service';
import type { IntentDetectionResult } from '../../../services/ai/detection.service';
import {
  parsePeopleCountResume,
  PEOPLE_COUNT_INVALID_REPLY_MESSAGE,
  PEOPLE_COUNT_PROMPT_MESSAGE,
  shouldAbandonPeopleCountForNewIntent,
  shouldBlockForMissingPeopleCount,
  shouldTreatBareNumberAsPartySize,
} from '../../../services/peopleCountGate.service';
import {
  CLOSED_ORDER_CANCELLED_BOT_MESSAGE,
  NO_PENDING_CLOSED_ORDER_BOT_MESSAGE,
} from '../../../services/productQuery/botMessages';
import {
  formatBotUserMessage,
  normalizeMetadata,
  partySizeMetadataFields,
} from '../../../services/productQuery/utils';
import { patchConversationMetadata, findOrCreateConversationState, omitConversationMetadataKeys } from '../../../repositories';
import { extractStrictNumericPeopleCount, resolvePartySizeFromReply } from '../../../helpers/peopleCountExtraction';
import { buildIntentAmbiguityInteractiveMessage } from '../../../services/intentAmbiguityConfirmation.service';
import { isHybridAgentMode, isReservationAgentEnabled, isCheckoutAgentEnabled } from '../../../config/env';
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

/**
 * Intents de flujo cerrado/transaccional que SIEMPRE deben quedarse en
 * el dispatcher determinístico, aun en `AGENT_MODE=hybrid`.
 *
 * Política por defecto: agent-first para intents abiertos de lenguaje natural.
 * Sólo se bloquea el paso al ReAct cuando el intent pertenece a un flujo donde
 * la UX depende de handlers con estado/payloads específicos.
 */
const CLOSED_INTENTS = new Set<ConversationIntent>([
  ConversationIntent.VIEW_MENU,
  ConversationIntent.VIEW_MENU_RETURN,
  ConversationIntent.CATEGORY,
  ConversationIntent.MENU_BY_TAG,
  ConversationIntent.CATEGORY_PAGE,
  ConversationIntent.CATEGORY_LIST_PAGE,
  ConversationIntent.FEATURED_PAGE,
  ConversationIntent.ORDER_SEARCH_PAGE,
  ConversationIntent.SELECT_PRODUCT,
  ConversationIntent.SELECT_ORDER_PRODUCT,
  ConversationIntent.RECOMMENDATION_REQUEST,
  ConversationIntent.COMPLEMENT_SHOW_SUGGESTIONS,
  ConversationIntent.RESERVATION,
  ConversationIntent.VIEW_RESERVATION,
  ConversationIntent.VIEW_QR,
  ConversationIntent.CHECKOUT,
  ConversationIntent.CANCEL_ORDER,
  ConversationIntent.END_CONVERSATION,
  // TRACK_ORDER NO está acá a propósito: no tenía ningún IntentHandler
  // registrado (intent muerto — "no handler for: TRACK_ORDER"). Ahora lo
  // resuelve el híbrido con get_order_status().
  ConversationIntent.PAYMENT_REQUEST,
  ConversationIntent.SUPPORT,
  ConversationIntent.ADD_PRODUCT,
  ConversationIntent.ADD_ITEM,
  ConversationIntent.REMOVE_ITEM,
  ConversationIntent.MODIFY_QUANTITY,
  ConversationIntent.CONFIRM_ADD,
  ConversationIntent.CONFIRM_REMOVE,
  ConversationIntent.CANCEL_REMOVE,
  ConversationIntent.INCREASE_ITEM,
  ConversationIntent.DECREASE_ITEM,
  ConversationIntent.INCREASE_ITEM_QUANTITY,
  ConversationIntent.DECREASE_ITEM_QUANTITY,
  ConversationIntent.MODIFY_QUANTITY,
  ConversationIntent.VIEW_CART,
  ConversationIntent.VIEW_CART_FOR_EDITION,
  ConversationIntent.SELECT_CART_ITEM,
  ConversationIntent.VIEW_ORDER,
  ConversationIntent.EDIT_ADDRESS,
  ConversationIntent.ONBOARDING_START,
  ConversationIntent.ONBOARDING_SUBMIT_ADDRESS_TEXT,
  ConversationIntent.ONBOARDING_SUBMIT_LOCATION,
  ConversationIntent.ONBOARDING_CONFIRM_ADDRESS,
  ConversationIntent.ONBOARDING_EDIT_ADDRESS,
  ConversationIntent.ONBOARDING_RETRY_ADDRESS,
  ConversationIntent.ONBOARDING_COMPLETE,
  ConversationIntent.SELECT_DELIVERY,
  ConversationIntent.SELECT_TAKE_AWAY,
]);

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

const unwrapHybridRun = async (
  hybrid: HybridAgentRunResult | null,
  enrichedCtx: EnrichedContext,
  checkoutHandoff?: CheckoutHandoffParams
): Promise<HandlerResult | null> => {
  if (!hybrid) return null;
  if (
    hybrid.kind === 'delegate_checkout' &&
    checkoutHandoff &&
    isCheckoutAgentEnabled()
  ) {
    return resolveCheckoutHandoff(enrichedCtx, checkoutHandoff);
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
  checkoutHandoff?: CheckoutHandoffParams
): Promise<HandlerResult | null> => {
  if (isHybridAgentMode() && (!enrichedCtx.detection || !CLOSED_INTENTS.has(enrichedCtx.detection.intent))) {
    try {
      const hybrid = await runHybridReactAgent(enrichedCtx);
      const result = await unwrapHybridRun(hybrid, enrichedCtx, checkoutHandoff);
      if (result) return result;
    } catch (err) {
      console.error('[hybrid-agent] failed, falling back to deterministic', err);
      // 429 TPM: no caer a ASK_QUESTION ("escribí tu pregunta") — empeora la UX.
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

      // D7 — si el platillo tiene variaciones y el payload todavía no trae
      // una elegida, hay que mostrar el picker ANTES de pedir la confirmación
      // de horario cerrado: si no, el cliente confirma un pedido que todavía
      // no terminó de definir, y al elegir la variedad se genera un payload
      // nuevo que dispara una segunda confirmación (síntoma 2 del plan).
      const { productId, variationIndex } = parseAddItemButtonPayload(payloadId);
      if (productId && variationIndex == null) {
        const item = await prisma.menu_item.findFirst({
          where: { id: productId, business_id: state.business!.id },
          select: { variations: true },
        });
        if (item && hasVariations(item)) {
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
 * Subgrafo NLP: cleanup awaitingIntentConfirmation + people-count gate +
 * detection LLM + ambigüedad + people-count missing + dispatch.
 * Fase 2: log `cta_fallback_post_click` cuando el usuario escribe texto libre
 * en vez de usar el botón del CTA mostrado en el turno anterior.
 */
export const nlpSubgraphNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const enrichedBase = state.enrichedCtx as unknown as EnrichedContext;
  const conversation = state.conversation!;
  const detectionContext = state.detectionContext!;
  let workingConversationState = state.workingConversationState;
  const business = state.business!;
  const customer = state.customer!;

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

  // Fase 2: detectar texto libre post-CTA (fallback del usuario)
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
      // Respuesta no clara → re-mostrar confirmación
      const confirmation = buildClosedOrderConfirmationMessage(state.businessStatus?.nextOpenText ?? null);
      return { handlerResult: { content: confirmation, isInteractive: true } };
    }
  }

  // Cuando abandonamos el gate de personas porque el usuario cambió de
  // intención, reutilizamos la detección ya calculada para no clasificar dos
  // veces el mismo mensaje.
  let precomputedDetection: IntentDetectionResult | null = null;
  // True cuando salimos del gate de personas en este turno: el gate de
  // "personas faltantes" debe poder volver a evaluarse como si fuera un mensaje
  // nuevo (la metadata en memoria todavía trae el flag viejo).
  let abandonedPeopleCountGate = false;
  let abandonedPartySizeDefer = false;

  // Modo híbrido: reanudar consulta de menú tras responder party size
  if (isHybridAgentMode() && metaPre.awaitingPartySize) {
    const resume = parsePeopleCountResume(metaPre);
    const reDetection = await detectIntentWithConfidence(
      userMessage,
      detectionContext
    );
    const extractedPeople = resolvePartySizeFromReply(
      userMessage,
      reDetection.quantity
    );

    if (resume && extractedPeople != null && extractedPeople > 0) {
      await patchConversationMetadata(conversation.id, {
        ...partySizeMetadataFields(extractedPeople),
        awaitingPartySize: false,
      });
      await omitConversationMetadataKeys(conversation.id, ['peopleCountResume']);
      workingConversationState = await findOrCreateConversationState(
        conversation.id
      );

      const resumedCtx: EnrichedContext = {
        ...enrichedBase,
        conversationState: workingConversationState,
        detection: resume.detection,
        message: {
          ...ctx.message!,
          type: 'text',
          text: { body: resume.userMessage },
        },
        hasAddress: state.hasAddress,
        isInCoverage: state.isInCoverage,
      };

      const resumedResult = await dispatchOrHybrid(resumedCtx, checkoutHandoff);
      if (!resumedResult) {
        return { earlyExit: 'no_handler_match', workingConversationState };
      }
      return {
        handlerResult: resumedResult,
        detection: resume.detection,
        dataCollectionDelegated: true,
        workingConversationState,
      };
    }

    if (shouldAbandonPeopleCountForNewIntent(reDetection, userMessage) && extractedPeople == null) {
      await omitConversationMetadataKeys(conversation.id, [
        'awaitingPartySize',
        'peopleCountResume',
      ]);
      precomputedDetection = reDetection;
      abandonedPartySizeDefer = true;
      workingConversationState = await findOrCreateConversationState(
        conversation.id
      );
    }
  }

  if (metaPre.awaitingPeopleCount) {
    const resume = parsePeopleCountResume(metaPre);
    if (resume) {
      const extractedPeople = extractStrictNumericPeopleCount(userMessage);
      if (extractedPeople != null && extractedPeople > 0) {
        await patchConversationMetadata(conversation.id, {
          ...partySizeMetadataFields(extractedPeople),
          awaitingPeopleCount: false,
        });
        await omitConversationMetadataKeys(conversation.id, ['peopleCountResume']);

        const resumedCtx: EnrichedContext = {
          ...enrichedBase,
          detection: resume.detection,
          message: {
            ...ctx.message!,
            type: 'text',
            text: { body: resume.userMessage },
          },
        };

        const resumedResult = await dispatchOrHybrid(resumedCtx, checkoutHandoff);
        if (!resumedResult) {
          return { earlyExit: 'no_handler_match', workingConversationState };
        }
        return { handlerResult: resumedResult, workingConversationState };
      }

      // No es un número válido. Antes de re-preguntar, revisamos si el usuario
      // cambió de intención o preguntó por otra cosa. Si la nueva detección es
      // accionable, descartamos el gate de personas (incluida la consulta
      // original guardada) y procesamos el mensaje nuevo con normalidad. Así el
      // usuario no queda atrapado pidiéndole un número que ya no quiere dar.
      const reDetection = await detectIntentWithConfidence(
        userMessage,
        detectionContext
      );

      if (shouldAbandonPeopleCountForNewIntent(reDetection, userMessage)) {
        await omitConversationMetadataKeys(conversation.id, [
          'awaitingPeopleCount',
          'peopleCountResume',
        ]);
        precomputedDetection = reDetection;
        abandonedPeopleCountGate = true;
      } else {
        return {
          handlerResult: {
            content: PEOPLE_COUNT_INVALID_REPLY_MESSAGE,
            isInteractive: false,
          } satisfies HandlerResult,
          earlyExit: 'awaiting_people_count_invalid',
        };
      }
    } else {
      await omitConversationMetadataKeys(conversation.id, [
        'awaitingPeopleCount',
        'peopleCountResume',
      ]);
    }
  }

  const detection =
    precomputedDetection ??
    (await detectIntentWithConfidence(userMessage, detectionContext));

  console.log('[NLP] Detection result:', detection);
  console.log('[NLP] Resolution metadata:', {
    finalIntent: detection.intent,
    confidence: detection.confidence,
    source: detection.resolutionSource || 'unknown',
    topCandidate: detection.topCandidate || null,
    rescueMargin: detection.rescueMargin ?? null,
  });

  // "2" solo tras pedir personas (o sin party size): no es MODIFY_QUANTITY.
  const metaAfterDetect = normalizeMetadata(workingConversationState?.metadata);
  if (
    shouldTreatBareNumberAsPartySize({
      userMessage,
      intent: detection.intent as ConversationIntent,
      metadata: metaAfterDetect,
      detectedProductName: detection.detectedProductName,
    })
  ) {
    const people = extractStrictNumericPeopleCount(userMessage);
    if (people != null) {
      const resume = parsePeopleCountResume(metaAfterDetect);
      await patchConversationMetadata(conversation.id, {
        ...partySizeMetadataFields(people),
        awaitingPartySize: false,
        awaitingPeopleCount: false,
      });
      await omitConversationMetadataKeys(conversation.id, [
        'peopleCountResume',
        'awaitingPartySize',
        'awaitingPeopleCount',
      ]);
      workingConversationState = await findOrCreateConversationState(
        conversation.id
      );

      console.log(
        JSON.stringify({
          event: '[dispatch] bare_number_as_party_size',
          people,
          hadResume: Boolean(resume),
          previousIntent: detection.intent,
          conversationId: conversation.id,
        })
      );

      if (resume) {
        const resumedCtx: EnrichedContext = {
          ...enrichedBase,
          conversationState: workingConversationState,
          detection: resume.detection,
          message: {
            ...ctx.message!,
            type: 'text',
            text: { body: resume.userMessage },
          },
          hasAddress: state.hasAddress,
          isInCoverage: state.isInCoverage,
        };
        const resumedResult = await dispatchOrHybrid(resumedCtx, checkoutHandoff);
        if (!resumedResult) {
          return { earlyExit: 'no_handler_match', workingConversationState };
        }
        return {
          handlerResult: resumedResult,
          detection: resume.detection,
          dataCollectionDelegated: true,
          workingConversationState,
        };
      }

      // Sin consulta congelada: el híbrido retoma con el dato ya persistido.
      detection.intent = ConversationIntent.UNKNOWN;
      detection.confidence = 1;
      detection.detectedProductName = null;
      detection.quantity = null;
      detection.quantityMode = null;
    }
  }

  if (shouldAskIntentConfirmation(detection)) {
    // Opción D: la confirmación se construye con la decisión del sistema
    // (`detection.intent`) como primera opción y la mejor alternativa como
    // segunda. Esto garantiza que el usuario nunca vea botones desalineados
    // del intent final que el sistema ya eligió.
    const top2 = [
      { intent: detection.intent, confidence: detection.confidence },
      detection.alternatives[0],
    ];
    await patchConversationMetadata(conversation.id, {
      awaitingIntentConfirmation: true,
      intentCandidates: top2,
    });
    const ambiguityMessage = buildIntentAmbiguityInteractiveMessage(top2);
    return {
      handlerResult: { content: ambiguityMessage, isInteractive: true },
      detection,
      earlyExit: 'asked_intent_confirmation',
    };
  }

  // willUseAgent determina si el turno irá al ReAct agent; se usa para:
  // 1) saltar el gate de party-size (el agente lo recolecta naturalmente)
  // 2) setear dataCollectionDelegated para saltar los post-gates
  const willUseAgent =
    isHybridAgentMode() && !CLOSED_INTENTS.has(detection.intent as ConversationIntent);

  const metaForGate = normalizeMetadata(workingConversationState?.metadata);
  if (abandonedPeopleCountGate || abandonedPartySizeDefer) {
    // La metadata en memoria todavía trae el flag viejo; lo limpiamos para que
    // el gate evalúe el mensaje nuevo como si fuera la primera vez.
    metaForGate.awaitingPeopleCount = false;
    metaForGate.awaitingPartySize = false;
    metaForGate.peopleCountResume = undefined;
  }

  // Híbrido: congelar consulta de menú y delegar al agente que pide party size
  if (
    willUseAgent &&
    !abandonedPartySizeDefer &&
    shouldBlockForMissingPeopleCount({
      intent: detection.intent,
      metadata: metaForGate,
    })
  ) {
    if (!metaForGate.awaitingPartySize) {
      await patchConversationMetadata(conversation.id, {
        awaitingPartySize: true,
        peopleCountResume: {
          userMessage,
          detection: JSON.parse(JSON.stringify(detection)),
        },
      });
      workingConversationState = await findOrCreateConversationState(
        conversation.id
      );
    }
  }

  // Gate duro de party-size solo en ruta determinística (no híbrida).
  if (
    !willUseAgent &&
    shouldBlockForMissingPeopleCount({
      intent: detection.intent,
      metadata: metaForGate,
    })
  ) {
    await patchConversationMetadata(conversation.id, {
      awaitingPeopleCount: true,
      peopleCountResume: {
        userMessage,
        detection: JSON.parse(JSON.stringify(detection)),
      },
    });
    return {
      handlerResult: {
        content: PEOPLE_COUNT_PROMPT_MESSAGE,
        isInteractive: false,
      },
      detection,
      earlyExit: 'asked_people_count',
    };
  }

  const enrichedCtx: EnrichedContext = {
    ...enrichedBase,
    conversationState: workingConversationState ?? enrichedBase.conversationState,
    detection,
    hasAddress: state.hasAddress,
    isInCoverage: state.isInCoverage,
  };

  // Intercept: si el intent es RESERVATION y el agente de reservas está
  // habilitado, activar reservation_agent_active e invocar el agente
  // directamente en este turno. Los turnos siguientes ya llegarán directo
  // a reservationAgentNode gracias al contextRoute='reservation_agent'.
  if (
    isReservationAgentEnabled() &&
    (detection.intent === ConversationIntent.RESERVATION ||
      detection.intent === ConversationIntent.VIEW_RESERVATION)
  ) {
    await patchConversationMetadata(conversation.id, {
      reservation_agent_active: true,
    });

    const bizId =
      typeof enrichedBase.business === 'object' && enrichedBase.business
        ? (enrichedBase.business as { id: string }).id
        : '';
    const environments = bizId ? await findActiveEnvironmentsByBusinessId(bizId) : [];

    let agentResult: Awaited<ReturnType<typeof runReservationAgent>>;
    try {
      agentResult = await runReservationAgent(enrichedCtx, {
        hasEnvironments: environments.length > 0,
        environmentNames: environments.map((e) => ({ id: e.id, name: e.name })),
      });
    } catch (err) {
      console.error('[reservation-agent] error en primer turno NLP:', err);
      agentResult = null;
    }

    if (!agentResult) {
      return { detection, earlyExit: 'no_handler_match' };
    }

    const { text, signals } = agentResult;

    if (signals.delegateToMain) {
      let mainResult: HandlerResult | null = null;
      try {
        const hybrid = await runHybridReactAgent(enrichedCtx);
        mainResult =
          hybrid?.kind === 'response' ? hybrid.handlerResult : null;
      } catch { /* no-op */ }
      return { handlerResult: mainResult ?? { content: text, isInteractive: false }, detection, dataCollectionDelegated: true };
    }
    if (signals.abandonReservation) {
      await patchConversationMetadata(conversation.id, { reservation_agent_active: false });
      return { handlerResult: { content: text, isInteractive: false }, detection, dataCollectionDelegated: true };
    }
    if (signals.presentSlots && signals.presentSlotsDate && bizId) {
      try {
        const parsedDate = normReservationDate(signals.presentSlotsDate);
        const slots = await fetchReservationSlotsForBusinessDate(bizId, parsedDate);
        if (slots.length > 0) {
          const slotList = buildListMessageFromButtons(
            text,
            slots.map((s) => ({ title: s.start_time, payload: `RESERVATION_SLOT:${s.id}`, description: `${s.start_time} – ${s.end_time}`, sectionTitle: 'Horarios disponibles' })),
            'Ver horarios', '', 'Elegí un horario'
          );
          return { handlerResult: { content: slotList, isInteractive: true }, detection, dataCollectionDelegated: true };
        }
      } catch { /* fallback a texto */ }
    }
    if (signals.presentEnvironments && environments.length > 0) {
      const buttons = [
        ...environments.map((env) => ({ title: env.name, payload: `RESERVATION_ENV:${env.id}`, description: '', sectionTitle: 'Ambientes' })),
        { title: 'Sin preferencia', payload: 'RESERVATION_ENV_NONE', description: 'Cualquier ambiente', sectionTitle: 'Ambientes' },
      ];
      const envList = buildListMessageFromButtons(text, buttons, 'Ver ambientes', '', 'Elegí un ambiente');
      return { handlerResult: { content: envList, isInteractive: true }, detection, dataCollectionDelegated: true };
    }
    return { handlerResult: { content: text, isInteractive: false }, detection, dataCollectionDelegated: true };
  }

  // Intercept: CHECKOUT en texto libre → sesión del checkout agent (igual que botón Finalizar)
  if (isCheckoutAgentEnabled() && detection.intent === ConversationIntent.CHECKOUT) {
    const business = state.business!;
    const customer = state.customer!;
    const phone = customer.phone_number ?? ctx.to;

    const emptyCart = await activateCheckoutSessionIfCartHasItems({
      businessId: business.id,
      phone,
      conversationId: conversation.id,
    });
    if (emptyCart) {
      return { handlerResult: emptyCart, detection, dataCollectionDelegated: true };
    }

    const deliveryEnabled =
      (state.businessConfig?.delivery_enabled ?? true) ||
      (state.businessConfig?.external_delivery_enabled ?? false);
    const takeawayEnabled = state.businessConfig?.takeaway_enabled ?? false;

    await applyDefaultFulfillmentIfSingleOption({
      businessId: business.id,
      phone,
      deliveryEnabled,
      takeawayEnabled,
    });

    const handlerResult = await resolveCheckoutAgentHandlerResult({
      enrichedCtx,
      checkoutCtx: {
        hasAddress: state.hasAddress ?? false,
        isInCoverage: state.isInCoverage ?? false,
        deliveryEnabled,
        takeawayEnabled,
      },
      conversationId: conversation.id,
    });

    return { handlerResult, detection, dataCollectionDelegated: true };
  }

  const result = await dispatchOrHybrid(enrichedCtx, checkoutHandoff);
  if (checkoutHandoff) {
    workingConversationState = await findOrCreateConversationState(conversation.id);
  }
  if (!result) {
    return { detection, earlyExit: 'no_handler_match' };
  }

  const isHumanHandover = detection.intent === ConversationIntent.SUPPORT;
  return {
    handlerResult: result,
    detection,
    isHumanHandover,
    dataCollectionDelegated: willUseAgent,
    workingConversationState,
  };
};
