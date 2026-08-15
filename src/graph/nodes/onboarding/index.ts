/**
 * Nodo LangGraph del agente de onboarding dedicado.
 *
 * Captura todos los turnos mientras el router asigna `onboarding_agent`
 * (Facts incompletos, sesión activa, staging o payloads) y los delega al
 * `onboardingAgent`.
 *
 * Responsabilidades del nodo (no del agente):
 *  - Interceptar payloads determinísticos ANTES de invocar al agente:
 *      ONBOARDING_CONFIRM_ADDRESS → guardar dirección vía AddressService.
 *      ONBOARDING_EDIT_ADDRESS   → volver a pedir dirección.
 *      message.type === 'location' → reverse geocode + staging + botones.
 *  - Activar `onboarding_agent_active` en el primer turno (incl. apertura por Facts).
 *  - Adjuntar botones WhatsApp cuando el agente devuelve señal `present_address_confirmation`.
 *  - Llamar runHybridReactAgent inline para señal `delegate_to_main` sin limpiar sesión.
 *  - Limpiar `onboarding_agent_active` cuando la dirección queda guardada.
 */

import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../../../repositories/conversationState.repository';
import { normalizeToHandlerResult } from '../../../controllers/webhook/utils/index';
import { textResponse } from '../../../controllers/webhook/utils/index';
import { AddressService } from '../../../services/address.service';
import { delegateToMainWithDetection } from '../session/delegateToMain';
import { buildResumeFollowUp } from '../session/buildResumeFollowUp';
import { buildDiscardedReentryMessage } from '../session/discardedSignalMessage';
import { runOnboardingAgent } from '../../../agents/onboardingAgent';
import { runHybridReactAgent } from '../../../agents/reactAgent';
import { detectIntentWithConfidence } from '../../../services/ai/detection.service';
import { findOrCreateConversationState } from '../../../repositories';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import { nextOnboardingStep } from '../../../services/onboarding/nextOnboardingStep';
import { loadLiveOnboardingFacts } from '../../../services/onboarding/loadLiveOnboardingFacts';
import type { HandlerResult } from '../../../controllers/webhook/types';
import type { EnrichedContext } from '../../../controllers/webhook/types';
import type { AgentState, AgentStateUpdate } from '../../state';

// ---------------------------------------------------------------------------
// Helper: limpiar sesión de onboarding
// ---------------------------------------------------------------------------

const clearOnboardingSession = async (conversationId: string): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [
    'onboarding_agent_active',
    'onboarding_step',
    'temp_address',
    'temp_lat',
    'temp_lng',
    'temp_zone_id',
    'awaiting_address',
    'pending_address_action',
  ]);
};

/**
 * Tras completar el perfil (dirección + nombre), "qué sigue" es del híbrido
 * (ADR-0002). Mismo patrón que finish_onboarding inline.
 */
const invokeHybridAfterProfileComplete = async (params: {
  enrichedBase: EnrichedContext;
  conversationId: string;
  detectionContext: AgentState['detectionContext'];
  userMessage: string;
  fallbackResult: HandlerResult | undefined;
}): Promise<HandlerResult | undefined> => {
  const { enrichedBase, conversationId, detectionContext, userMessage, fallbackResult } = params;
  if (!detectionContext || !userMessage.trim()) return fallbackResult;

  try {
    const freshState = await findOrCreateConversationState(conversationId);
    const hybrid = await runHybridReactAgent({
      ...enrichedBase,
      detection: await detectIntentWithConfidence(userMessage, detectionContext),
      conversationState: freshState,
    });
    return hybrid?.kind === 'response' ? hybrid.handlerResult : fallbackResult;
  } catch (err) {
    console.error('[onboarding-agent] error invocando híbrido tras completar perfil:', err);
    return fallbackResult;
  }
};

/**
 * Tras confirmar dirección: si falta el nombre, se mantiene Ownership y se
 * pide el nombre; si el perfil está completo, se libera e invoca al híbrido.
 */
const continueAfterAddressSaved = async (params: {
  enrichedBase: EnrichedContext;
  conversationId: string;
  customerId: string;
  detectionContext: AgentState['detectionContext'];
  userMessage: string;
  ackResult: HandlerResult | undefined;
}): Promise<HandlerResult | undefined> => {
  const {
    enrichedBase,
    conversationId,
    customerId,
    detectionContext,
    userMessage,
    ackResult,
  } = params;

  const facts = await loadLiveOnboardingFacts({ conversationId, customerId });
  const step = nextOnboardingStep(facts);

  if (step === 'name') {
    await patchConversationMetadata(conversationId, { onboarding_agent_active: true });
    const resume = buildResumeFollowUp({
      kind: 'onboarding',
      step: 'name',
      stagedAddress: null,
    });
    const ackText =
      typeof ackResult?.content === 'string'
        ? ackResult.content
        : '✅ Dirección guardada.';
    const body = resume.text ? `${ackText}\n\n${resume.text}` : ackText;
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] continue_to_name',
        conversationId,
      })
    );
    return { content: body, isInteractive: false };
  }

  await clearOnboardingSession(conversationId);
  return invokeHybridAfterProfileComplete({
    enrichedBase,
    conversationId,
    detectionContext,
    userMessage,
    fallbackResult: ackResult,
  });
};

/**
 * Gate de confirmación (botón o señal): solo persistir si el paso derivado
 * es `confirm` y hay staging. Evita writes huérfanas (agent-factory §3.10).
 */
const assertConfirmStepOrBlock = async (params: {
  conversationId: string;
  customerId: string;
}): Promise<HandlerResult | null> => {
  const facts = await loadLiveOnboardingFacts(params);
  const step = nextOnboardingStep(facts);
  if (step !== 'confirm' || !facts.stagedAddress) {
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] confirm_gate_blocked',
        step,
        hasStaged: Boolean(facts.stagedAddress),
        conversationId: params.conversationId,
      })
    );
    return (
      textResponse(
        'Todavía no tengo una dirección para confirmar. ¿Me la decís o compartís tu ubicación?'
      ) ?? null
    );
  }
  return null;
};

// ---------------------------------------------------------------------------
// Nodo principal
// ---------------------------------------------------------------------------

export const onboardingAgentNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const enrichedBase = state.enrichedCtx as unknown as EnrichedContext;
  const conversation = state.conversation!;
  const conversationId = conversation.id;
  const payloadId = ctx.payloadId;
  const addressService = new AddressService();

  const customerId =
    typeof enrichedBase.customer === 'object' && enrichedBase.customer
      ? (enrichedBase.customer as { id: string }).id
      : '';

  // ── ONBOARDING_CONFIRM_ADDRESS — guardado determinístico ──────────────────
  // Misma fuente de verdad que el camino de texto libre (resolveStagedAddressConfirmation):
  // `addressService.process()` es el método LEGACY (ver @deprecated) y no
  // pasa `skipSmallTalkMenu`, por eso mostraba el saludo de bienvenida
  // completo al confirmar por botón (bug real, visto en pruebas manuales).
  if (payloadId === 'ONBOARDING_CONFIRM_ADDRESS') {
    if (!customerId) {
      return { dataCollectionDelegated: true };
    }
    const blocked = await assertConfirmStepOrBlock({ conversationId, customerId });
    if (blocked) {
      return { handlerResult: blocked, dataCollectionDelegated: true };
    }
    const result = await addressService.resolveStagedAddressConfirmation(enrichedBase, true);
    const ackResult = normalizeToHandlerResult(result);
    const finalResult = await continueAfterAddressSaved({
      enrichedBase,
      conversationId,
      customerId,
      detectionContext: state.detectionContext,
      userMessage: ctx.message?.text?.body?.trim() ?? '',
      ackResult,
    });
    return {
      handlerResult: finalResult,
      dataCollectionDelegated: true,
    };
  }

  // ── ONBOARDING_EDIT_ADDRESS — volver a capturar ───────────────────────────
  if (payloadId === 'ONBOARDING_EDIT_ADDRESS') {
    await patchConversationMetadata(conversationId, {
      onboarding_step: 'CAPTURE',
      temp_address: null,
      temp_lat: null,
      temp_lng: null,
      temp_zone_id: null,
    });
    const editResult = textResponse(
      '📍 Decime tu dirección o compartí tu ubicación para volver a intentarlo.'
    );
    return {
      handlerResult: editResult ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  // ── Mensaje tipo `location` — mismo camino de staging que el texto ────────
  // El pin es un payload estructurado (D4/H-C): reverse-geocode + validar
  // zona + staging, sin pasar por `.process()`/`.handleLocation()` (wizard
  // legacy por `onboarding_step`, `@deprecated`). Mismo copy con botones que
  // el camino de texto — no un tercer mensaje distinto.
  if (ctx.message?.type === 'location') {
    const location = (ctx.message as { location?: { lat: number; lng: number } }).location;
    const businessId =
      typeof enrichedBase.business === 'object' && enrichedBase.business
        ? (enrichedBase.business as { id: string }).id
        : '';
    if (!location || !businessId || !customerId) {
      return { dataCollectionDelegated: true };
    }

    const facts = await loadLiveOnboardingFacts({ conversationId, customerId });
    const step = nextOnboardingStep(facts);
    if (step !== 'capture') {
      console.log(
        JSON.stringify({
          event: '[onboarding-agent] location_gate_blocked',
          step,
          conversationId,
        })
      );
      return {
        handlerResult:
          textResponse(
            step === 'name'
              ? 'Ya tengo tu ubicación/dirección. ¿Cómo es tu nombre?'
              : 'Ahora no estoy pidiendo una dirección nueva. ¿En qué te ayudo?'
          ) ?? undefined,
        dataCollectionDelegated: true,
      };
    }

    const staged = await addressService.resolveAndStageAddressFromLocation({
      businessId,
      conversationId,
      lat: location.lat,
      lng: location.lng,
    });

    if (staged.status === 'out_of_coverage') {
      return {
        handlerResult: textResponse(
          '🚫 Lo siento, no tenemos cobertura en esa zona.\n\nProbá con otra dirección.'
        ) ?? undefined,
        dataCollectionDelegated: true,
      };
    }

    const confirmationMsg = addressService.buildConfirmAddressMessage(
      `📍 Detecté tu ubicación:\n${staged.formattedAddress}\n\n¿Es correcta?`
    );
    return {
      handlerResult: { content: confirmationMsg, isInteractive: true, skipBodyHumanization: true },
      dataCollectionDelegated: true,
    };
  }

  // ── Activar sesión en el primer turno ────────────────────────────────────
  const wsMeta = normalizeMetadata(state.workingConversationState?.metadata);
  const sessionJustOpened = !wsMeta.onboarding_agent_active;
  if (sessionJustOpened) {
    await patchConversationMetadata(conversationId, { onboarding_agent_active: true });
    const openedByFacts =
      wsMeta.onboarding_step == null &&
      payloadId !== 'ONBOARDING_CONFIRM_ADDRESS' &&
      payloadId !== 'ONBOARDING_EDIT_ADDRESS';
    if (openedByFacts) {
      console.log(
        JSON.stringify({
          event: '[onboarding] session_opened_by_facts',
          conversationId,
        })
      );
    }
  }

  // ── Invocar el agente de onboarding ──────────────────────────────────────
  let agentResult: Awaited<ReturnType<typeof runOnboardingAgent>>;
  try {
    agentResult = await runOnboardingAgent(enrichedBase);
  } catch (err) {
    console.error('[onboarding-agent] error invocando el agente:', err);
    agentResult = null;
  }

  if (!agentResult) {
    return {
      handlerResult: textResponse(
        '🤖\n\n*Un momento* 🙏\n\nNo pude procesar tu solicitud ahora. ¿Podés intentarlo de nuevo?'
      ) ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  const { text, rawText, signals } = agentResult;

  // P1.2 — regresión conversacional en el primer turno: sin texto ni señal de
  // salida/confirmación. Pedir dirección en prosa (happy path) produce texto
  // y no dispara esto; no hay matcher de frases.
  if (
    sessionJustOpened &&
    !text.trim() &&
    !signals.finishOnboarding &&
    !signals.delegateToMain &&
    signals.addressConfirmationResolved === null
  ) {
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] first_turn_no_signal',
        conversationId,
      })
    );
  }

  // ── Señal: delegar turno al agente principal (off-topic temporal) ─────────
  if (signals.delegateToMain) {
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] delegate_to_main',
        reason: signals.delegateToMainReason,
        conversationId,
      })
    );
    let mainResult: HandlerResult | null = null;
    let discardedReentrySignal = false;
    try {
      const delegated = await delegateToMainWithDetection({
        enrichedCtx: enrichedBase,
        userMessage: ctx.message?.text?.body?.trim() ?? '',
        detectionContext: state.detectionContext,
      });
      mainResult = delegated.handlerResult;
      discardedReentrySignal = delegated.discardedReentrySignal;
    } catch (err) {
      console.error('[onboarding-agent] error en delegate_to_main:', err);
    }

    if (discardedReentrySignal) {
      console.log(
        JSON.stringify({
          event: '[onboarding-agent] delegation_signal_discarded',
          conversationId,
        })
      );
      return {
        handlerResult: { content: buildDiscardedReentryMessage('onboarding'), isInteractive: false },
        dataCollectionDelegated: true,
      };
    }

    const baseResult = mainResult ?? { content: text, isInteractive: false };

    // Anexar (no reemplazar) el recordatorio del paso pendiente (dirección o
    // nombre), para que el usuario no tenga que adivinar que el onboarding
    // sigue activo (H-03). Paso derivado del estado real (H-B/P0.3).
    let onboardingStep: ReturnType<typeof nextOnboardingStep> = 'capture';
    let stagedAddressForResume: string | null = null;
    if (customerId) {
      try {
        const stepState = await loadLiveOnboardingFacts({ conversationId, customerId });
        onboardingStep = nextOnboardingStep(stepState);
        stagedAddressForResume = stepState.stagedAddress;
      } catch (err) {
        console.error('[onboarding-agent] error derivando paso para el resume:', err);
      }
    }
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] resume_after_delegate',
        step: onboardingStep,
        conversationId,
      })
    );
    const resume = buildResumeFollowUp({
      kind: 'onboarding',
      step: onboardingStep,
      stagedAddress: stagedAddressForResume,
    });

    if (!resume.text) {
      return { handlerResult: baseResult, dataCollectionDelegated: true };
    }

    // Paso `confirm`: un solo mensaje interactivo (respuesta lateral + resume
    // como body + botones Confirmar/Editar), en vez de texto plano seguido de
    // un followUp que reabra la pregunta por separado (mismo criterio que el
    // checkout con `resume.checkoutPendingAction`).
    if (
      resume.onboardingStagedAddress &&
      typeof baseResult.content === 'string'
    ) {
      const combinedBody = `${baseResult.content}\n\n${resume.text}`;
      return {
        handlerResult: {
          content: addressService.buildConfirmAddressMessage(combinedBody),
          isInteractive: true,
          skipBodyHumanization: true,
        },
        dataCollectionDelegated: true,
      };
    }

    return {
      handlerResult: {
        ...baseResult,
        content:
          typeof baseResult.content === 'string'
            ? `${baseResult.content}\n\n${resume.text}`
            : baseResult.content,
      },
      dataCollectionDelegated: true,
    };
  }

  // ── Señal: cerrar sesión permanentemente (Tarea 3.5 / H-06) ───────────────
  if (signals.finishOnboarding) {
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] finish_onboarding',
        reason: signals.finishOnboardingReason,
        conversationId,
      })
    );
    // La tool `finish_onboarding` ya limpió metadata. Si el cliente pidió algo
    // concreto en el mismo mensaje ("mostrame el menú"), invocar al híbrido
    // inline (mismo patrón que `handback_to_main` en checkout) para que reciba
    // una respuesta real en este turno, no solo el texto de despedida del LLM
    // de onboarding (que no tiene tools para mostrar menú/CTAs).
    const userMessage = ctx.message?.text?.body?.trim() ?? '';
    let hybridResult: HandlerResult | null = null;
    if (state.detectionContext && userMessage) {
      try {
        const freshState = await findOrCreateConversationState(conversationId);
        const hybrid = await runHybridReactAgent({
          ...enrichedBase,
          detection: await detectIntentWithConfidence(userMessage, state.detectionContext),
          conversationState: freshState,
        });
        hybridResult = hybrid?.kind === 'response' ? hybrid.handlerResult : null;
      } catch (err) {
        console.error('[onboarding-agent] error en finish_onboarding inline hybrid:', err);
      }
    }
    return {
      handlerResult: hybridResult ?? { content: text, isInteractive: false },
      dataCollectionDelegated: true,
    };
  }

  // ── Señal: el cliente resolvió la confirmación en texto libre ─────────────
  // (vía PASO PENDIENTE + resolve_address_confirmation, mismo patrón que la
  // confirmación final del checkout — ADR-0002: el guardado real pasa por
  // `AddressService`, la tool solo señala.)
  if (signals.addressConfirmationResolved !== null) {
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] address_confirmation_resolved',
        confirmed: signals.addressConfirmationResolved,
        conversationId,
      })
    );
    if (!customerId) {
      return { dataCollectionDelegated: true };
    }
    if (signals.addressConfirmationResolved) {
      const blocked = await assertConfirmStepOrBlock({ conversationId, customerId });
      if (blocked) {
        return { handlerResult: blocked, dataCollectionDelegated: true };
      }
    }
    const result = await addressService.resolveStagedAddressConfirmation(
      enrichedBase,
      signals.addressConfirmationResolved
    );
    if (!signals.addressConfirmationResolved) {
      return {
        handlerResult: normalizeToHandlerResult(result),
        dataCollectionDelegated: true,
      };
    }

    const ackResult = normalizeToHandlerResult(result);
    const finalResult = await continueAfterAddressSaved({
      enrichedBase,
      conversationId,
      customerId,
      detectionContext: state.detectionContext,
      userMessage: ctx.message?.text?.body?.trim() ?? '',
      ackResult,
    });
    return {
      handlerResult: finalResult,
      dataCollectionDelegated: true,
    };
  }

  // ── Señal: nombre guardado → perfil completo ──────────────────────────────
  if (signals.profileComplete) {
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] onboarding_profile_complete',
        conversationId,
      })
    );
    await clearOnboardingSession(conversationId);
    const fallback: HandlerResult = { content: text, isInteractive: false };
    const finalResult = await invokeHybridAfterProfileComplete({
      enrichedBase,
      conversationId,
      detectionContext: state.detectionContext,
      userMessage: ctx.message?.text?.body?.trim() ?? '',
      fallbackResult: fallback,
    });
    return {
      handlerResult: finalResult,
      dataCollectionDelegated: true,
    };
  }

  // ── Dirección staged sin confirmar: adjuntar botones al texto del agente ──
  // No se reemplaza el texto del LLM por una frase enlatada — el texto ya
  // suele pedir la confirmación con naturalidad ("¿es correcta?"). Lo único
  // que se garantiza estructuralmente son los botones (no depender de que el
  // modelo recuerde llamar present_address_confirmation). Se relee la
  // metadata FRESCA (no `state.workingConversationState`, que es la foto de
  // antes de este turno) porque check_address_coverage puede haber staged la
  // dirección recién en este mismo turno — con la foto vieja, los botones
  // aparecían recién en el turno siguiente (visto en pruebas manuales).
  const freshState = await findOrCreateConversationState(conversationId);
  const freshMeta = normalizeMetadata(freshState.metadata);
  const rawTempAddress = freshMeta.temp_address;
  const tempAddress =
    freshMeta.onboarding_step === 'CONFIRM' && typeof rawTempAddress === 'string'
      ? rawTempAddress.trim()
      : null;

  if (tempAddress) {
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] confirmation_buttons_attached',
        hadRawText: Boolean(rawText?.trim()),
        conversationId,
      })
    );
    const confirmBody =
      rawText?.trim() || `Encontré esta dirección:\n${tempAddress}\n\n¿Es correcta?`;
    const confirmationMsg = addressService.buildConfirmAddressMessage(confirmBody);
    return {
      handlerResult: {
        content: confirmationMsg,
        isInteractive: true,
        skipBodyHumanization: true,
      },
      dataCollectionDelegated: true,
    };
  }

  // ── Solo texto (pide dirección, explica cobertura, etc.) ─────────────────
  return {
    handlerResult: { content: text, isInteractive: false },
    dataCollectionDelegated: true,
  };
};
