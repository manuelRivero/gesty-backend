/**
 * Agente ReAct dedicado a la gestión de reservas.
 *
 * Se invoca desde `reservationAgentNode` cuando hay una sesión de reserva
 * activa (`reservation_agent_active` en metadata). Gestiona en lenguaje
 * natural la recolección de todos los datos (fecha, slot, personas, ambiente)
 * y expone señales para adjuntar UI de WhatsApp desde el nodo orquestador.
 *
 * Diferencias clave respecto al agente de checkout:
 *  - Dos tools de salida: `delegate_to_main` (temporal) y `abandon_reservation` (permanente).
 *  - `delegate_to_main` NO limpia `reservation_agent_active`; el nodo llama
 *    `runHybridReactAgent` inline y la sesión continúa en el turno siguiente.
 *  - Múltiples señales de UI: slots, ambientes, confirmación.
 *  - Tool `resolve_date` para parsear fechas en lenguaje natural.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage } from '@langchain/core/messages';
import { getReactReasonerLlm } from '../config/llm';
import { buildReservationAgentSystemPrompt } from '../prompts/botPersonality';
import { resolvePersonalityForBusiness } from '../services/botPersonality.service';
import { allReservationTools } from '../tools/reservation';
import type { EnrichedContext } from '../controllers/webhook/types';
import { formatBotUserMessage, normalizeMetadata } from '../services/productQuery/utils';

// ---------------------------------------------------------------------------
// Cache de agentes por personalidad (mismo patrón que checkoutAgent.ts)
// ---------------------------------------------------------------------------

let cachedAgents = new Map<string, ReturnType<typeof createReactAgent>>();

const buildAgent = (personalityId: string, personalityPrompt: string) => {
  const cacheKey = `reservation:${personalityId}`;
  let agent = cachedAgents.get(cacheKey);
  if (!agent) {
    agent = createReactAgent({
      llm: getReactReasonerLlm(),
      tools: allReservationTools,
      prompt: buildReservationAgentSystemPrompt(personalityPrompt),
    });
    cachedAgents.set(cacheKey, agent);
  }
  return agent;
};

/** Solo para uso en tests: resetea el cache del agente de reservas. */
export const resetReservationAgentCacheForTesting = (): void => {
  cachedAgents = new Map();
};

// ---------------------------------------------------------------------------
// Context message [ESTADO DE LA RESERVA]
// ---------------------------------------------------------------------------

export interface ReservationAgentContext {
  /** Hay ambientes activos configurados en el negocio (determina si se muestra paso de ambiente). */
  hasEnvironments: boolean;
  environmentNames: Array<{ id: string; name: string }>;
}

const DAY_NAMES_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const buildReservationContextMessage = (
  ctx: EnrichedContext,
  reservationCtx: ReservationAgentContext
): string => {
  const userMsg = ctx.message?.text?.body ?? '';
  const customerName = (ctx.customer as { name?: string | null })?.name?.trim() || null;

  // Fecha actual con día de semana
  const now = new Date();
  const dayName = DAY_NAMES_ES[now.getDay()];
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const currentDateLabel = `${dd}/${mm}/${yyyy} (${dayName})`;

  // Estado del borrador desde metadata
  const meta = normalizeMetadata(ctx.conversationState?.metadata);
  const draft = meta.reservation_draft ?? {};

  const dateLabel = draft.date ?? 'no elegida';
  const slotLabel =
    draft.time && draft.endTime
      ? `${draft.time}–${draft.endTime}`
      : draft.time ?? 'no elegido';
  const partySizeLabel = draft.partySize != null ? String(draft.partySize) : 'no informado';

  let environmentLabel: string;
  if (!reservationCtx.hasEnvironments) {
    environmentLabel = 'no hay ambientes';
  } else if (draft.environmentId === null) {
    environmentLabel = 'sin preferencia';
  } else if (draft.environmentId) {
    const env = reservationCtx.environmentNames.find((e) => e.id === draft.environmentId);
    environmentLabel = env?.name ?? draft.environmentId;
  } else {
    environmentLabel = 'no elegido';
  }

  const lines = [
    `[ESTADO DE LA RESERVA]`,
    `- Fecha actual: ${currentDateLabel}`,
    `- Fecha elegida: ${dateLabel}`,
    `- Horario: ${slotLabel}`,
    `- Personas: ${partySizeLabel}`,
    `- Ambiente: ${environmentLabel}`,
    `- Nombre del cliente: ${customerName ?? 'no informado'}`,
  ];

  return `${lines.join('\n')}\n\n${userMsg}`;
};

// ---------------------------------------------------------------------------
// Extracción de señales del agente
// ---------------------------------------------------------------------------

export interface ReservationAgentSignals {
  presentSlots: boolean;
  presentSlotsDate: string | null;
  presentEnvironments: boolean;
  presentConfirmation: boolean;
  delegateToMain: boolean;
  delegateToMainReason: string | null;
  abandonReservation: boolean;
  abandonReservationReason: string | null;
}

const extractSignals = (messages: unknown[]): ReservationAgentSignals => {
  const signals: ReservationAgentSignals = {
    presentSlots: false,
    presentSlotsDate: null,
    presentEnvironments: false,
    presentConfirmation: false,
    delegateToMain: false,
    delegateToMainReason: null,
    abandonReservation: false,
    abandonReservationReason: null,
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
        date?: string;
        reason?: string;
      };
      if (data.signal === 'present_slots') {
        signals.presentSlots = true;
        signals.presentSlotsDate = data.date ?? null;
      }
      if (data.signal === 'present_environments') {
        signals.presentEnvironments = true;
      }
      if (data.signal === 'present_confirmation') {
        signals.presentConfirmation = true;
      }
      if (data.signal === 'delegate_to_main') {
        signals.delegateToMain = true;
        signals.delegateToMainReason = data.reason ?? null;
      }
      if (data.signal === 'abandon_reservation') {
        signals.abandonReservation = true;
        signals.abandonReservationReason = data.reason ?? null;
      }
    } catch {
      /* ignorar mensajes no-JSON */
    }
  }

  return signals;
};

// ---------------------------------------------------------------------------
// Extracción del texto final del agente (idéntico a checkoutAgent.ts)
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
// Resultado del agente de reservas
// ---------------------------------------------------------------------------

export interface ReservationAgentResult {
  text: string;
  signals: ReservationAgentSignals;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const runReservationAgent = async (
  ctx: EnrichedContext,
  reservationCtx: ReservationAgentContext
): Promise<ReservationAgentResult | null> => {
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

  const contextMessage = buildReservationContextMessage(ctx, reservationCtx);

  const inputs = {
    messages: [new HumanMessage(contextMessage)],
  };

  const out = await agent.invoke(inputs, {
    recursionLimit: 12,
    configurable: {
      businessId,
      customerId,
      customerPhone,
      conversationId,
      conversationStartedAt,
    },
  });

  const rawText = extractFinalText(out);
  const agentMessages = (out as { messages?: unknown[] }).messages ?? [];
  const signals = extractSignals(agentMessages);

  const text = rawText
    ? rawText.startsWith('🤖')
      ? rawText
      : formatBotUserMessage('Reservas', '📅', rawText)
    : formatBotUserMessage(
        'Reservas',
        '📅',
        'Estoy procesando tu reserva, un momento...'
      );

  return { text, signals };
};
