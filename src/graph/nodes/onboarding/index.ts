/**
 * Nodo LangGraph del agente de onboarding dedicado.
 *
 * Captura todos los turnos mientras `metadata.onboarding_agent_active` está
 * activo y los delega al `onboardingAgent`.
 *
 * Responsabilidades del nodo (no del agente):
 *  - Interceptar payloads determinísticos ANTES de invocar al agente:
 *      ONBOARDING_CONFIRM_ADDRESS → guardar dirección vía AddressService.
 *      ONBOARDING_EDIT_ADDRESS   → volver a pedir dirección.
 *      message.type === 'location' → reverse geocode + staging + botones.
 *  - Activar `onboarding_agent_active` en el primer turno.
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

  // ── ONBOARDING_CONFIRM_ADDRESS — guardado determinístico ──────────────────
  if (payloadId === 'ONBOARDING_CONFIRM_ADDRESS') {
    const result = await addressService.process(enrichedBase);
    await clearOnboardingSession(conversationId);
    if (!result) {
      return { dataCollectionDelegated: true };
    }
    return {
      handlerResult: normalizeToHandlerResult(result),
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

  // ── Mensaje tipo `location` — procesado determinístico ────────────────────
  if (ctx.message?.type === 'location') {
    const result = await addressService.process(enrichedBase);
    if (!result) {
      return { dataCollectionDelegated: true };
    }
    return {
      handlerResult: normalizeToHandlerResult(result),
      dataCollectionDelegated: true,
    };
  }

  // ── Activar sesión en el primer turno ────────────────────────────────────
  const wsMeta = normalizeMetadata(state.workingConversationState?.metadata);
  if (!wsMeta.onboarding_agent_active) {
    await patchConversationMetadata(conversationId, { onboarding_agent_active: true });
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

  const { text, signals } = agentResult;

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

    // Anexar (no reemplazar) el recordatorio de que falta la dirección,
    // para que el usuario no tenga que adivinar que el onboarding sigue activo (H-03).
    const resume = buildResumeFollowUp({ kind: 'onboarding' });

    return {
      handlerResult: resume.text
        ? {
            ...baseResult,
            content:
              typeof baseResult.content === 'string'
                ? `${baseResult.content}\n\n${resume.text}`
                : baseResult.content,
          }
        : baseResult,
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
    const result = await addressService.resolveStagedAddressConfirmation(
      enrichedBase,
      signals.addressConfirmationResolved
    );
    if (signals.addressConfirmationResolved) {
      await clearOnboardingSession(conversationId);
    }
    return {
      handlerResult: normalizeToHandlerResult(result),
      dataCollectionDelegated: true,
    };
  }

  // ── Señal: mostrar botones de confirmación de dirección ───────────────────
  if (signals.presentAddressConfirmation) {
    const freshMeta = normalizeMetadata(state.workingConversationState?.metadata);
    const rawTempAddress = freshMeta.temp_address;
    const tempAddress = typeof rawTempAddress === 'string' ? rawTempAddress.trim() : null;

    if (!tempAddress) {
      // Sin dirección staged, solo texto del agente
      return {
        handlerResult: { content: text, isInteractive: false },
        dataCollectionDelegated: true,
      };
    }

    // ADR-0002: la confirmación es un solo mensaje determinístico. El texto
    // libre del LLM (`text`) se descarta acá a propósito — nada garantiza
    // que no afirme "ya confirmado" mientras el botón real todavía espera
    // respuesta (pasó en producción: dos mensajes contradictorios el mismo
    // turno, uno diciendo "dirección confirmada" y otro preguntando "¿es
    // correcta?"). Igual que `present_fulfillment_options`/`present_payment_options`
    // en checkout: la UI de confirmación reemplaza el texto, no lo acompaña.
    const confirmationMsg = addressService.buildConfirmAddressMessage(
      `📍 Encontré esta dirección:\n${tempAddress}\n\n¿Es correcta?`
    );

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
