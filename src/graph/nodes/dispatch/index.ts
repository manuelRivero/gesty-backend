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
import {
  detectIntentWithConfidence,
  shouldAskIntentConfirmation,
} from '../../../services/ai/detection.service';
import {
  parsePeopleCountResume,
  PEOPLE_COUNT_INVALID_REPLY_MESSAGE,
  PEOPLE_COUNT_PROMPT_MESSAGE,
  shouldBlockForMissingPeopleCount,
} from '../../../services/peopleCountGate.service';
import {
  normalizeMetadata,
  partySizeMetadataFields,
} from '../../../services/productQuery/utils';
import {
  findOrCreateConversationState,
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../../../repositories';
import { extractStrictNumericPeopleCount } from '../../../helpers/peopleCountExtraction';
import { buildIntentAmbiguityInteractiveMessage } from '../../../services/intentAmbiguityConfirmation.service';
import { isHybridAgentMode } from '../../../config/env';
import { runHybridReactAgent } from '../../../agents/reactAgent';
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
  ConversationIntent.TRACK_ORDER,
  ConversationIntent.PAYMENT_REQUEST,
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
]);

const dispatchOrHybrid = async (
  enrichedCtx: EnrichedContext
): Promise<HandlerResult | null> => {
  if (isHybridAgentMode() && !CLOSED_INTENTS.has(enrichedCtx.detection.intent)) {
    try {
      const hybrid = await runHybridReactAgent(enrichedCtx);
      if (hybrid) return hybrid;
    } catch (err) {
      console.error('[hybrid-agent] failed, falling back to deterministic', err);
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

  const result = await dispatchInteractive(enrichedBase);
  if (!result) {
    return { earlyExit: 'interactive_no_payload' };
  }
  return { handlerResult: result };
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

        const resumedResult = await dispatchOrHybrid(resumedCtx);
        if (!resumedResult) {
          return { earlyExit: 'no_handler_match' };
        }
        return { handlerResult: resumedResult };
      }

      return {
        handlerResult: {
          content: PEOPLE_COUNT_INVALID_REPLY_MESSAGE,
          isInteractive: false,
        } satisfies HandlerResult,
        earlyExit: 'awaiting_people_count_invalid',
      };
    }

    await omitConversationMetadataKeys(conversation.id, [
      'awaitingPeopleCount',
      'peopleCountResume',
    ]);
  }

  const detection = await detectIntentWithConfidence(
    userMessage,
    detectionContext
  );

  console.log('[NLP] Detection result:', detection);
  console.log('[NLP] Resolution metadata:', {
    finalIntent: detection.intent,
    confidence: detection.confidence,
    source: detection.resolutionSource || 'unknown',
    topCandidate: detection.topCandidate || null,
    rescueMargin: detection.rescueMargin ?? null,
  });

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

  const metaForGate = normalizeMetadata(workingConversationState?.metadata);

  if (
    shouldBlockForMissingPeopleCount({
      intent: detection.intent,
      metadata: metaForGate,
      detectionQuantity: detection.quantity,
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
    conversationState: workingConversationState,
    detection,
  };

  const result = await dispatchOrHybrid(enrichedCtx);
  if (!result) {
    return { detection, earlyExit: 'no_handler_match' };
  }
  return { handlerResult: result, detection };
};
