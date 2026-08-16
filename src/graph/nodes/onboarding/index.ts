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
import { buildSmallTalkMenu } from '../../../services/smallTalk.service';
import { delegateToMainWithDetection } from '../session/delegateToMain';
import { buildResumeFollowUp } from '../session/buildResumeFollowUp';
import { buildDiscardedReentryMessage } from '../session/discardedSignalMessage';
import {
  extractConfirmAddressPending,
  runOnboardingAgent,
} from '../../../agents/onboardingAgent';
import { runHybridReactAgent } from '../../../agents/reactAgent';
import { detectIntentWithConfidence } from '../../../services/ai/detection.service';
import { findOrCreateConversationState } from '../../../repositories';
import {
  formatBotUserMessage,
  normalizeMetadata,
} from '../../../services/productQuery/utils';
import { nextOnboardingStep } from '../../../services/onboarding/nextOnboardingStep';
import { loadLiveOnboardingFacts } from '../../../services/onboarding/loadLiveOnboardingFacts';
import { incrementRefusalCount } from '../../../services/intent/intentRefusal.service';
import { ConversationIntent } from '../../../types/conversationIntent';
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

/** Intents que en paso `capture` liberan onboarding (dirección omitible). */
const SKIP_ADDRESS_INTENTS = new Set<string>([
  ConversationIntent.RESERVATION,
  ConversationIntent.VIEW_RESERVATION,
  ConversationIntent.VIEW_MENU,
  ConversationIntent.BUSINESS_HOURS,
  ConversationIntent.ASK_QUESTION,
]);

/**
 * Misma liberación que finish_onboarding(not_needed): refusal + clear sesión.
 */
const liberateOnboardingNotNeeded = async (conversationId: string): Promise<void> => {
  await incrementRefusalCount(conversationId, 'OBTENER_DIRECCION');
  await incrementRefusalCount(conversationId, 'OBTENER_NOMBRE');
  await clearOnboardingSession(conversationId);
};

/**
 * Tras liberar onboarding: híbrido inline, sin clasificar intent.
 * Abrir reserva en prosa = Fase B (`start_reservation_session`).
 */
const handoffAfterOnboardingLiberated = async (params: {
  enrichedBase: EnrichedContext;
  conversationId: string;
  detectionContext: AgentState['detectionContext'];
  userMessage: string;
  fallbackText: string;
}): Promise<HandlerResult> => {
  const { enrichedBase, conversationId, userMessage, fallbackText } = params;
  const fallback: HandlerResult = {
    content: fallbackText,
    isInteractive: false,
  };
  if (!userMessage.trim()) return fallback;

  try {
    const freshState = await findOrCreateConversationState(conversationId);
    const hybrid = await runHybridReactAgent({
      ...enrichedBase,
      conversationState: freshState,
    });
    return hybrid?.kind === 'response' ? hybrid.handlerResult : fallback;
  } catch (err) {
    console.error('[onboarding-agent] error en handoff tras liberar:', err);
    return fallback;
  }
};

/** Cierre de perfil: welcome de menú, sin re-procesar el tipable en el híbrido. */
const completeProfileWithWelcome = async (
  enrichedBase: EnrichedContext,
  conversationId: string,
  bodyText: string
): Promise<HandlerResult> => {
  await clearOnboardingSession(conversationId);
  try {
    const menu = await buildSmallTalkMenu(enrichedBase, bodyText);
    if (menu && typeof menu !== 'string') {
      return {
        content: menu,
        isInteractive: true,
        skipBodyHumanization: true,
      };
    }
    if (typeof menu === 'string') {
      return { content: menu, isInteractive: false };
    }
  } catch (err) {
    console.error('[onboarding-agent] error armando welcome tras perfil:', err);
  }
  return {
    content: formatBotUserMessage('Listo', '✅', bodyText),
    isInteractive: false,
  };
};

/**
 * Tras confirmar dirección: si falta el nombre, se pide; si el perfil está
 * completo, welcome (sin híbrido sobre el mensaje del usuario).
 */
const continueAfterAddressSaved = async (params: {
  enrichedBase: EnrichedContext;
  conversationId: string;
  customerId: string;
  ackResult: HandlerResult | undefined;
}): Promise<HandlerResult | undefined> => {
  const { enrichedBase, conversationId, customerId, ackResult } = params;

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
        : formatBotUserMessage('Dirección guardada', '✅', 'Listo, ya la anoté.');
    const body = resume.text ? `${ackText}\n\n${resume.text}` : ackText;
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] continue_to_name',
        conversationId,
      })
    );
    return { content: body, isInteractive: false };
  }

  if (step === 'done') {
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] profile_complete_after_address',
        conversationId,
      })
    );
    return completeProfileWithWelcome(
      enrichedBase,
      conversationId,
      'Ya guardé tus datos personales. ¿Qué te gustaría hacer ahora?'
    );
  }

  return ackResult;
};

/** Tras save_customer_name: seguir a dirección (soft) o cerrar con welcome. */
const continueAfterNameSaved = async (params: {
  enrichedBase: EnrichedContext;
  conversationId: string;
  customerId: string;
}): Promise<HandlerResult> => {
  const { enrichedBase, conversationId, customerId } = params;
  const facts = await loadLiveOnboardingFacts({ conversationId, customerId });
  const step = nextOnboardingStep(facts);

  if (step === 'capture' || step === 'confirm') {
    await patchConversationMetadata(conversationId, { onboarding_agent_active: true });
    const resume = buildResumeFollowUp({
      kind: 'onboarding',
      step,
      stagedAddress: facts.stagedAddress,
    });
    const ack = formatBotUserMessage(
      'Nombre anotado',
      '✅',
      resume.text ??
        'Si querés delivery, necesito tu dirección para validar la zona. Si solo mirás el menú o reservás, podés omitirla por ahora.'
    );
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] continue_to_address',
        step,
        conversationId,
      })
    );
    if (step === 'confirm' && facts.stagedAddress) {
      return {
        content: new AddressService().buildConfirmAddressMessage(ack),
        isInteractive: true,
        skipBodyHumanization: true,
      };
    }
    return { content: ack, isInteractive: false };
  }

  console.log(
    JSON.stringify({
      event: '[onboarding-agent] profile_complete_after_name',
      conversationId,
    })
  );
  return completeProfileWithWelcome(
    enrichedBase,
    conversationId,
    'Ya guardé tus datos personales. ¿Qué te gustaría hacer ahora?'
  );
};

const applyAddressConfirmation = async (params: {
  enrichedBase: EnrichedContext;
  conversationId: string;
  customerId: string;
  confirmed: boolean;
}): Promise<AgentStateUpdate> => {
  const { enrichedBase, conversationId, customerId, confirmed } = params;
  const addressService = new AddressService();
  const blocked = await assertConfirmStepOrBlock({ conversationId, customerId });
  if (blocked) {
    return { handlerResult: blocked, dataCollectionDelegated: true };
  }
  const result = await addressService.resolveStagedAddressConfirmation(
    enrichedBase,
    confirmed
  );
  if (!confirmed) {
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
    ackResult,
  });
  return { handlerResult: finalResult, dataCollectionDelegated: true };
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
  if (payloadId === 'ONBOARDING_CONFIRM_ADDRESS') {
    if (!customerId) {
      return { dataCollectionDelegated: true };
    }
    return applyAddressConfirmation({
      enrichedBase,
      conversationId,
      customerId,
      confirmed: true,
    });
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
              ? 'Antes de la ubicación, ¿con qué nombre te gustaría que te agende?'
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

  // ── Paso capture: menú / reserva / consulta → liberar sin esperar al ReAct ─
  // Clasificador de intent (no regex). Misma liberación que finish(not_needed).
  if (
    customerId &&
    !payloadId &&
    ctx.message?.type !== 'location' &&
    state.detectionContext
  ) {
    const tipableText = ctx.message?.text?.body?.trim() ?? '';
    if (tipableText) {
      const factsForSkip = await loadLiveOnboardingFacts({
        conversationId,
        customerId,
      });
      if (nextOnboardingStep(factsForSkip) === 'capture') {
        const detection = await detectIntentWithConfidence(
          tipableText,
          state.detectionContext
        );
        if (SKIP_ADDRESS_INTENTS.has(detection.intent)) {
          console.log(
            JSON.stringify({
              event: '[onboarding-agent] skip_address_by_intent',
              intent: detection.intent,
              conversationId,
            })
          );
          await liberateOnboardingNotNeeded(conversationId);
          const handoff = await handoffAfterOnboardingLiberated({
            enrichedBase,
            conversationId,
            detectionContext: state.detectionContext,
            userMessage: tipableText,
            fallbackText: formatBotUserMessage(
              'Listo',
              '✅',
              'Dale, seguimos sin la dirección por ahora. ¿En qué te ayudo?'
            ),
          });
          return { handlerResult: handoff, dataCollectionDelegated: true };
        }
      }
    }
  }

  // ── Tipable confirm (sí/no) — mismo borde que el botón, sin esperar al ReAct ─
  if (customerId && !payloadId) {
    const tipableText = ctx.message?.text?.body?.trim() ?? '';
    if (tipableText && ctx.message?.type !== 'location') {
      const tipableFacts = await loadLiveOnboardingFacts({ conversationId, customerId });
      if (
        nextOnboardingStep(tipableFacts) === 'confirm' &&
        tipableFacts.stagedAddress
      ) {
        const extraction = await extractConfirmAddressPending(tipableText);
        console.log(
          JSON.stringify({
            event: '[onboarding-agent] confirm_tipable_extraction',
            status: extraction.status,
            confidence: extraction.confidence,
            source: extraction.source,
            conversationId,
          })
        );
        if (extraction.status === 'fulfilled' && extraction.value) {
          return applyAddressConfirmation({
            enrichedBase,
            conversationId,
            customerId,
            confirmed: extraction.value.confirmed === true,
          });
        }
      }
    }
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
    // La tool ya limpió metadata + refusal. Handoff: reserva → agente; resto → híbrido.
    const userMessage = ctx.message?.text?.body?.trim() ?? '';
    const handoff = await handoffAfterOnboardingLiberated({
      enrichedBase,
      conversationId,
      detectionContext: state.detectionContext,
      userMessage,
      fallbackText: text,
    });
    return {
      handlerResult: handoff,
      dataCollectionDelegated: true,
    };
  }

  // ── Señal: el cliente resolvió la confirmación en texto libre (tool) ──────
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
    return applyAddressConfirmation({
      enrichedBase,
      conversationId,
      customerId,
      confirmed: signals.addressConfirmationResolved,
    });
  }

  // ── Señal: nombre guardado → dirección soft o welcome ─────────────────────
  if (signals.customerNameSaved) {
    console.log(
      JSON.stringify({
        event: '[onboarding-agent] customer_name_saved',
        conversationId,
      })
    );
    if (!customerId) {
      return { dataCollectionDelegated: true };
    }
    const finalResult = await continueAfterNameSaved({
      enrichedBase,
      conversationId,
      customerId,
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
    // Body del interactivo: prosa (el header WA ya es "Confirmá tu dirección").
    // No envolver con 🤖 acá — duplicaría encabezados con el header del botón.
    const confirmBody =
      rawText?.trim().replace(/^🤖\s*/u, '').trim() ||
      `Encontré esta dirección:\n${tempAddress}\n\n¿Es correcta?`;
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
