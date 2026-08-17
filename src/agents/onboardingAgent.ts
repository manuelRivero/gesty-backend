/**
 * Agente ReAct dedicado al onboarding (perfil mínimo: dirección + nombre).
 *
 * Se invoca desde `onboardingAgentNode` cuando el router asigna
 * `contextRoute = 'onboarding_agent'`: Ownership por Facts (sin dirección
 * usable o sin nombre, con refusal del Goal faltante en 0) o por sesión /
 * staging / payloads Confirmar|Editar. Ver `shouldOwnOnboardingTurn` y
 * `PLAN-ACCION-ONBOARDING-OWNERSHIP-ENTRY.md`.
 *
 * Writes con `withGate` contra `nextOnboardingStep(loadLiveOnboardingFacts)`.
 * Handshake: `delegate_to_main` (temporal) / `finish_onboarding` (permanente).
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage } from '@langchain/core/messages';
import { getReactReasonerLlm } from '../config/llm';
import { buildAgentHistoryMessages } from './conversationHistory';
import { buildOnboardingAgentSystemPrompt } from '../prompts/botPersonality';
import { resolvePersonalityForBusiness } from '../services/botPersonality.service';
import { allOnboardingTools } from '../tools/onboarding';
import { normalizeMetadata, ensureBotUserMessageFormat } from '../services/productQuery/utils';
import { z } from 'zod';
import {
  extractPendingTurnResponse,
  formatPendingExtractionBlock,
} from '../services/ai/extractPendingTurnResponse';
import type { EnrichedContext } from '../controllers/webhook/types';
import { nextOnboardingStep } from '../services/onboarding/nextOnboardingStep';
import { loadLiveOnboardingFacts } from '../services/onboarding/loadLiveOnboardingFacts';

// ---------------------------------------------------------------------------
// Paso pendiente: confirmar la dirección staged (mismo patrón que checkout —
// ver `checkoutAgent.ts` / ADR-0002). Un mensaje libre mientras se espera
// confirmación puede ser "sí"/"no" o una pregunta lateral ("cuánto sale el
// envío"); un clasificador LLM dedicado decide cuál es, en vez de dejar que
// el agente principal lo intuya por su cuenta (no lo hacía de forma confiable).
// ---------------------------------------------------------------------------

export const ConfirmAddressPendingSchema = z.object({ confirmed: z.boolean() });
export const CONFIRM_ADDRESS_QUESTION = '¿Es correcta la dirección?';
export const CONFIRM_ADDRESS_VALUE_HINTS = `{
  "confirmed": true | false
}
- true: sí, dale, confirmo, es correcta, está bien
- false: no, esa no es, editar, cambiar, quiero cambiarla`;
export const CONFIRM_ADDRESS_ACTION_DESCRIPTION =
  'El cliente debe confirmar si la dirección propuesta es correcta o pedir editarla.';

/** Clasificador tipable de confirmación (para ledger del agente y short-circuit del nodo). */
export async function extractConfirmAddressPending(userMessage: string) {
  return extractPendingTurnResponse({
    userMessage,
    pendingAction: 'confirm_address',
    botQuestion: CONFIRM_ADDRESS_QUESTION,
    schema: ConfirmAddressPendingSchema,
    valueHints: CONFIRM_ADDRESS_VALUE_HINTS,
    actionDescription: CONFIRM_ADDRESS_ACTION_DESCRIPTION,
  });
}

// ---------------------------------------------------------------------------
// Cache de agentes por personalidad
// ---------------------------------------------------------------------------

let cachedAgents = new Map<string, ReturnType<typeof createReactAgent>>();

const buildAgent = (personalityId: string, personalityPrompt: string) => {
  const cacheKey = `onboarding:${personalityId}`;
  let agent = cachedAgents.get(cacheKey);
  if (!agent) {
    agent = createReactAgent({
      llm: getReactReasonerLlm(),
      tools: allOnboardingTools,
      prompt: buildOnboardingAgentSystemPrompt(personalityPrompt),
    });
    cachedAgents.set(cacheKey, agent);
  }
  return agent;
};

/** Solo para uso en tests: resetea el cache del agente de onboarding. */
export const resetOnboardingAgentCacheForTesting = (): void => {
  cachedAgents = new Map();
};

// ---------------------------------------------------------------------------
// Context message [ESTADO DEL ONBOARDING]
// ---------------------------------------------------------------------------

/** Acción esperada según el paso derivado — ledger tipable para el modelo (H-E/P1.1). */
const expectedActionForOnboardingStep = (
  step: ReturnType<typeof nextOnboardingStep>,
  addressEdit: boolean
): string => {
  switch (step) {
    case 'name':
      return 'pedir con qué nombre agendarlo; save_customer_name cuando lo provea';
    case 'capture':
      if (addressEdit) {
        return 'está CAMBIANDO la dirección ya guardada: check_address_coverage(text) con lo que escribió; NO pidas nombre ni ofrezcas omitir';
      }
      return (
        'explicar que la dirección sirve para validar zona si pide delivery; ' +
        'ofrecer omitir si solo menú/reserva/consulta (finish_onboarding); ' +
        'check_address_coverage(text) si la da'
      );
    case 'confirm':
      return 'preguntar si la dirección propuesta es correcta (botones); resolve_address_confirmation si responde en texto';
    case 'done':
      return 'ninguna';
  }
};

const goalForOnboardingStep = (
  step: ReturnType<typeof nextOnboardingStep>
): string => {
  switch (step) {
    case 'name':
      return 'OBTENER_NOMBRE';
    case 'capture':
    case 'confirm':
      return 'OBTENER_DIRECCION';
    case 'done':
      return 'ninguno';
  }
};

const buildOnboardingContextMessage = async (ctx: EnrichedContext): Promise<string> => {
  const userMsg = ctx.message?.text?.body ?? '';

  const meta = normalizeMetadata(ctx.conversationState?.metadata);
  const rawTempAddress = meta.temp_address;
  const tempAddress = typeof rawTempAddress === 'string' ? rawTempAddress.trim() : null;
  const onboardingStepMeta = meta.onboarding_step ?? null;

  const hasStagedAddress = Boolean(tempAddress) && onboardingStepMeta === 'CONFIRM';
  const stagedAddressLabel = hasStagedAddress && tempAddress ? tempAddress : 'no informada';
  const coverageLabel = hasStagedAddress ? 'en cobertura (pendiente de confirmar)' : 'sin evaluar';

  const customerId =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { id: string }).id
      : '';
  const conversationId = ctx.conversationId ?? '';
  let step: ReturnType<typeof nextOnboardingStep> = hasStagedAddress ? 'confirm' : 'capture';
  let customerName: string | null =
    (ctx.customer as { name?: string | null })?.name?.trim() || null;
  let addressEdit = false;
  if (conversationId && customerId) {
    try {
      const stepState = await loadLiveOnboardingFacts({ conversationId, customerId });
      step = nextOnboardingStep(stepState);
      if (!stepState.hasCustomerName) customerName = null;
      addressEdit = stepState.hasSavedAddress && (step === 'capture' || step === 'confirm');
    } catch (err) {
      console.error('[onboarding-agent] error derivando paso para el ledger:', err);
    }
  }
  console.log(
    JSON.stringify({ event: '[onboarding-agent] step', step, conversationId })
  );

  const lines = [
    `[ESTADO DEL ONBOARDING]`,
    `- Dirección propuesta: ${stagedAddressLabel}`,
    `- Estado de cobertura: ${coverageLabel}`,
    `- Nombre del cliente: ${customerName ?? 'no informado'}`,
    `- Paso actual: ${step}`,
    `- Goal: ${goalForOnboardingStep(step)}`,
    `- Acción esperada: ${expectedActionForOnboardingStep(step, addressEdit)}`,
  ];

  const userText = userMsg.trim();
  const hasPayload = Boolean(ctx.payloadId?.trim());
  let extractionBlock = '';

  if (hasStagedAddress && userText && !hasPayload) {
    const extraction = await extractConfirmAddressPending(userText);
    console.log(
      JSON.stringify({
        event: '[onboarding-pending] extraction',
        status: extraction.status,
        confidence: extraction.confidence,
        source: extraction.source,
        conversationId: ctx.conversationId,
      })
    );
    extractionBlock = formatPendingExtractionBlock({
      pendingAction: 'confirm_address',
      botQuestion: CONFIRM_ADDRESS_QUESTION,
      status: extraction.status,
      confidence: extraction.confidence,
      value: extraction.value,
      reason: extraction.reason,
    });
  }

  const contextParts = [lines.join('\n')];
  if (extractionBlock) {
    contextParts.push('', extractionBlock);
  }
  if (userMsg) {
    contextParts.push('', userMsg);
  }

  return contextParts.join('\n');
};

// ---------------------------------------------------------------------------
// Señales del agente
// ---------------------------------------------------------------------------

export interface OnboardingAgentSignals {
  /** `null` = no se resolvió este turno; `true`/`false` = el cliente confirmó o pidió editar. */
  addressConfirmationResolved: boolean | null;
  delegateToMain: boolean;
  delegateToMainReason: string | null;
  finishOnboarding: boolean;
  finishOnboardingReason: string | null;
  /** Tras save_customer_name (el nodo deriva si sigue capture o cierra). */
  customerNameSaved: boolean;
}

const extractSignals = (messages: unknown[]): OnboardingAgentSignals => {
  const signals: OnboardingAgentSignals = {
    addressConfirmationResolved: null,
    delegateToMain: false,
    delegateToMainReason: null,
    finishOnboarding: false,
    finishOnboardingReason: null,
    customerNameSaved: false,
  };

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as Record<string, unknown>;
    if (typeof m.tool_call_id !== 'string') continue;

    const rawContent = typeof m.content === 'string' ? m.content : null;
    if (!rawContent) continue;

    try {
      const data = JSON.parse(rawContent) as {
        signal?: string;
        reason?: string;
        confirmed?: boolean;
      };
      if (data.signal === 'address_confirmation_resolved') {
        signals.addressConfirmationResolved = data.confirmed === true;
      }
      if (data.signal === 'delegate_to_main') {
        signals.delegateToMain = true;
        signals.delegateToMainReason = data.reason ?? null;
      }
      if (data.signal === 'finish_onboarding') {
        signals.finishOnboarding = true;
        signals.finishOnboardingReason = data.reason ?? null;
      }
      if (data.signal === 'customer_name_saved') {
        signals.customerNameSaved = true;
      }
    } catch {
      /* ignorar mensajes no-JSON */
    }
  }

  return signals;
};

// ---------------------------------------------------------------------------
// Extracción del texto final (idéntico a checkoutAgent.ts / reservationAgent.ts)
// ---------------------------------------------------------------------------

const extractFinalText = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null) return null;
  const messages = (result as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as { content?: unknown };
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return (
      last.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (typeof part === 'object' && part && 'text' in part) {
            return String((part as { text: unknown }).text ?? '');
          }
          return '';
        })
        .join('')
        .trim() || null
    );
  }
  return null;
};

// ---------------------------------------------------------------------------
// Resultado del agente
// ---------------------------------------------------------------------------

export interface OnboardingAgentResult {
  text: string;
  /** Texto del LLM sin el wrapper de `formatBotUserMessage` — para embeberlo dentro de otro mensaje (ej. tarjeta de confirmación) sin duplicar el header "🤖". */
  rawText: string | null;
  signals: OnboardingAgentSignals;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const runOnboardingAgent = async (
  ctx: EnrichedContext
): Promise<OnboardingAgentResult | null> => {
  const businessId =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { id: string }).id
      : '';
  if (!businessId) return null;

  const { id: personalityId, promptText } =
    await resolvePersonalityForBusiness(businessId);
  const agent = buildAgent(personalityId, promptText);

  const customerId =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { id: string }).id
      : '';
  const customerPhone =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { phone_number?: string }).phone_number ?? ctx.to
      : ctx.to;
  const conversationId = ctx.conversationId;
  const conversationStartedAt =
    typeof ctx.conversation === 'object' && ctx.conversation
      ? (ctx.conversation as { started_at?: Date }).started_at?.toISOString() ?? ''
      : '';

  const contextMessage = await buildOnboardingContextMessage(ctx);

  const history = await buildAgentHistoryMessages({
    conversationId,
    startedAt:
      typeof ctx.conversation === 'object' && ctx.conversation
        ? (ctx.conversation as { started_at?: Date }).started_at ?? null
        : null,
    currentMessageId: ctx.message?.id ?? null,
  });

  const out = await agent.invoke(
    { messages: [...history, new HumanMessage(contextMessage)] },
    {
      recursionLimit: 8,
      configurable: {
        businessId,
        customerId,
        customerPhone,
        conversationId,
        conversationStartedAt,
      },
    }
  );

  const rawText = extractFinalText(out);
  const agentMessages = (out as { messages?: unknown[] }).messages ?? [];
  const signals = extractSignals(agentMessages);

  let formatTitle = 'Bienvenida';
  let formatEmoji = '👋';
  let formatFallback =
    'Necesito algunos datos para atenderte mejor. ¿Con qué nombre te gustaría que te agende?';
  if (conversationId && customerId) {
    try {
      const step = nextOnboardingStep(
        await loadLiveOnboardingFacts({ conversationId, customerId })
      );
      if (step === 'capture' || step === 'confirm') {
        formatTitle = 'Dirección de entrega';
        formatEmoji = '📍';
        formatFallback =
          'Si querés un pedido con delivery, necesito tu dirección para validar la zona. Si solo mirás el menú o reservás, podés omitirla por ahora.';
      } else if (step === 'name') {
        formatTitle = 'Tu nombre';
        formatEmoji = '👋';
        formatFallback = '¿Con qué nombre te gustaría que te agende?';
      }
    } catch {
      /* fallback de título arriba */
    }
  }

  const text = ensureBotUserMessageFormat(
    rawText,
    formatTitle,
    formatEmoji,
    formatFallback
  );

  return { text, rawText, signals };
};
