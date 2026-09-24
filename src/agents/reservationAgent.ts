/**
 * Agente ReAct dedicado a la gestión de reservas.
 *
 * Se invoca desde `reservationAgentNode` cuando hay una sesión de reserva
 * activa (`reservation_agent_active` en metadata). Gestiona en lenguaje
 * natural la recolección de todos los datos (fecha, slot, personas, ambiente)
 * y expone señales para adjuntar UI de WhatsApp desde el nodo orquestador.
 *
 * Diferencias clave respecto al agente de checkout:
 *  - Tres tools de salida: `delegate_to_main` (temporal, sesión sigue activa),
 *    `handback_reservation` (temporal, limpia la sesión pero conserva el
 *    borrador) y `abandon_reservation` (permanente, borra todo).
 *  - `delegate_to_main` NO limpia `reservation_agent_active`; el nodo llama
 *    `runHybridReactAgent` inline y la sesión continúa en el turno siguiente.
 *  - Múltiples señales de UI: slots, ambientes, confirmación.
 *  - La fecha la interpreta el propio agente (cualquier idioma, cualquier
 *    expresión) y la verifica el gate de `save_reservation_date` contra el
 *    reloj único de `services/reservations/clock.ts`.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage } from '@langchain/core/messages';
import { getReactReasonerLlm } from '../config/llm';
import { buildAgentHistoryMessages } from './conversationHistory';
import { buildReservationAgentSystemPrompt } from '../prompts/botPersonality';
import { resolvePersonalityForBusiness } from '../services/botPersonality.service';
import { allReservationTools } from '../tools/reservation';
import type { EnrichedContext } from '../controllers/webhook/types';
import { formatBotUserMessage } from '../services/productQuery/utils';
import { readReservationDraft } from '../services/reservations/draft.repository';
import {
  buildPendingReservationDishFaqContextLines,
  readPendingReservationDishFaq,
} from '../services/reservations/pendingReservationDishFaq';
import { coerceIanaTimezone, currentDateLabel } from '../services/reservations/clock';
import {
  nextReservationStep,
  expectedActionForReservationStep,
} from '../services/reservations/nextReservationStep';
import { z } from 'zod';
import {
  extractPendingTurnResponse,
  formatPendingExtractionBlock,
} from '../services/ai/extractPendingTurnResponse';

// ---------------------------------------------------------------------------
// Pendings tipables (§3.11) — extractores compartidos por nodo (short-circuit)
// y ledger del agente (reprompt / delegate).
// ---------------------------------------------------------------------------

export const ConfirmReservationPendingSchema = z.object({ confirmed: z.boolean() });
export type ConfirmReservationPendingValue = z.infer<typeof ConfirmReservationPendingSchema>;

export const CONFIRM_RESERVATION_QUESTION = '¿Confirmás la reserva?';
export const CONFIRM_RESERVATION_VALUE_HINTS = `{
  "confirmed": true | false
}
- true: sí, dale, confirmo, ok, adelante, listo, procedé
- false: no, cancelá, mejor no, esperá, todavía no, pará`;
export const CONFIRM_RESERVATION_ACTION_DESCRIPTION =
  'El usuario debe confirmar o cancelar la reserva antes de que se cree en la base de datos.';

/** Clasificador tipable de confirmación (nodo + ledger). */
export async function extractConfirmReservationPending(userMessage: string) {
  return extractPendingTurnResponse({
    userMessage,
    pendingAction: 'confirm_reservation',
    botQuestion: CONFIRM_RESERVATION_QUESTION,
    schema: ConfirmReservationPendingSchema,
    valueHints: CONFIRM_RESERVATION_VALUE_HINTS,
    actionDescription: CONFIRM_RESERVATION_ACTION_DESCRIPTION,
  });
}

export const SelectEnvironmentPendingSchema = z.object({
  /** UUID del ambiente, o null = sin preferencia. */
  environmentId: z.string().nullable(),
});
export type SelectEnvironmentPendingValue = z.infer<typeof SelectEnvironmentPendingSchema>;

export const SELECT_ENVIRONMENT_QUESTION = '¿En qué ambiente preferís reservar?';

export function buildSelectEnvironmentValueHints(
  environments: Array<{ id: string; name: string }>
): { valueHints: string; actionDescription: string } {
  const lines = environments.map((e) => `- "${e.id}": ${e.name}`);
  const names = environments.map((e) => e.name).filter(Boolean).join(', ');
  return {
    valueHints: `{
  "environmentId": <uuid del catálogo> | null
}
${lines.join('\n')}
- null: sin preferencia, cualquiera, me da igual, lo que sea, no importa
- Match parcial inequívoco OK (ej. "salón" → el uuid de "Salón principal" si es el único salón)
- Si nombra algo que NO está en el catálogo (ej. "carpa cerca de los juegos", "terraza" cuando no hay terraza): NO inventes uuid y NO uses null (null solo es "me da igual"). Dejá el turno como no-fulfilled / reprompt para que el sistema aclare y re-ofrezca: ${names || 'los ambientes listados'}.`,
    actionDescription:
      'El usuario debe elegir un ambiente del catálogo del local, o indicar que no tiene preferencia (environmentId null). Si pide un ambiente inexistente, no cumplas el paso.',
  };
}

/** Clasificador tipable de ambiente (nodo + ledger). Catálogo acotado al negocio. */
export async function extractSelectEnvironmentPending(
  userMessage: string,
  environments: Array<{ id: string; name: string }>
) {
  const { valueHints, actionDescription } = buildSelectEnvironmentValueHints(environments);
  return extractPendingTurnResponse({
    userMessage,
    pendingAction: 'select_environment',
    botQuestion: SELECT_ENVIRONMENT_QUESTION,
    schema: SelectEnvironmentPendingSchema,
    valueHints,
    actionDescription,
  });
}

/** True si el valor fulfilled apunta a un ambiente del catálogo o a "sin preferencia". */
export function isValidEnvironmentSelection(
  environmentId: string | null,
  environments: Array<{ id: string; name: string }>
): boolean {
  if (environmentId === null) return true;
  return environments.some((e) => e.id === environmentId);
}

export type ReservationSlotOption = {
  id: string;
  startTime: string;
  endTime: string;
};

export const SelectSlotPendingSchema = z.object({
  /** UUID del slot del catálogo del día. */
  slotId: z.string(),
});
export type SelectSlotPendingValue = z.infer<typeof SelectSlotPendingSchema>;

export const SELECT_SLOT_QUESTION = '¿A qué hora preferís reservar?';

export function buildSelectSlotValueHints(
  slots: ReservationSlotOption[]
): { valueHints: string; actionDescription: string } {
  const lines = slots.map((s) => `- "${s.id}": ${s.startTime}–${s.endTime}`);
  const bandHint = `
Bandas (elegí UN uuid del catálogo cuya startTime caiga en la banda):
- "mediodía", "al mediodía", "almuerzo" → startTime entre 11:00 y 15:59
- "a la tarde", "tarde" → 16:00–18:59
- "a la noche", "noche", "sábado a la noche" → 19:00–23:59
Si hay varios en la banda, elegí el primero de esa banda en el catálogo. Si no hay ninguno, status no-fulfilled (el sistema re-ofrecerá la lista).`;
  return {
    valueHints: `{
  "slotId": <uuid del catálogo>
}
${lines.join('\n')}
Usá el uuid exacto del catálogo cuando el usuario nombre un horario (ej. "a las 19:00", "sí, a las 19", "20:30") o una banda (${bandHint.trim()}).`,
    actionDescription:
      'El usuario debe elegir un horario del catálogo (hora exacta o banda mediodía/tarde/noche) para la fecha ya guardada en el borrador.',
  };
}

/** Clasificador tipable de horario (nodo + ledger). Catálogo acotado a la fecha del draft. */
export async function extractSelectSlotPending(
  userMessage: string,
  slots: ReservationSlotOption[]
) {
  const { valueHints, actionDescription } = buildSelectSlotValueHints(slots);
  return extractPendingTurnResponse({
    userMessage,
    pendingAction: 'select_slot',
    botQuestion: SELECT_SLOT_QUESTION,
    schema: SelectSlotPendingSchema,
    valueHints,
    actionDescription,
  });
}

/** True si el valor fulfilled apunta a un slot del catálogo del día. */
export function isValidSlotSelection(
  slotId: string,
  slots: ReservationSlotOption[]
): boolean {
  return slots.some((s) => s.id === slotId);
}

export const PartySizePendingSchema = z.object({
  /** Cantidad de personas (entero ≥ 1). */
  count: z.number().int().positive(),
});
export type PartySizePendingValue = z.infer<typeof PartySizePendingSchema>;

export const PARTY_SIZE_QUESTION = '¿Para cuántas personas?';

export function buildPartySizeValueHints(maxCapacity: number | null): {
  valueHints: string;
  actionDescription: string;
} {
  const maxLine =
    maxCapacity != null && maxCapacity > 0
      ? `\nMáximo del local (capacidad combinable): ${maxCapacity}. Si pide más, igual extraé el número (el borde validará).`
      : '';
  return {
    valueHints: `{
  "count": <entero ≥ 1>
}
- "4", "somos 4", "para cuatro", "4 personas" → 4
- "dos", "para dos", "somos dos" → 2
- "solo yo", "uno" → 1${maxLine}`,
    actionDescription:
      'El usuario debe indicar cuántas personas asistirán a la reserva (número entero positivo).',
  };
}

/** Clasificador tipable de cantidad de personas (nodo + ledger). */
export async function extractPartySizePending(
  userMessage: string,
  maxCapacity: number | null = null
) {
  const { valueHints, actionDescription } = buildPartySizeValueHints(maxCapacity);
  return extractPendingTurnResponse({
    userMessage,
    pendingAction: 'party_size',
    botQuestion: PARTY_SIZE_QUESTION,
    schema: PartySizePendingSchema,
    valueHints,
    actionDescription,
  });
}

/**
 * True si el count fulfilled es usable.
 * `maxCapacity <= 0` = sin tope conocido (mismo criterio que la tool).
 */
export function isValidPartySizeSelection(
  count: number,
  maxCapacity: number
): boolean {
  if (!Number.isInteger(count) || count < 1) return false;
  if (maxCapacity > 0 && count > maxCapacity) return false;
  return true;
}

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
  /**
   * Slots del día de la fecha del draft (id ↔ horario). Vacío si no hay fecha
   * o no hay turnos ese día. Alimenta tipable `select_slot` y el ledger.
   */
  availableSlots?: ReservationSlotOption[];
  /**
   * Capacidad combinable del local (suma de mesas). Alimenta tipable `party_size`
   * y el ledger; `null`/`0` = sin tope conocido.
   */
  maxPartySize?: number | null;
  /**
   * Tras un tipable fulfilled en el mismo turno (slot / party size / ambiente): no
   * re-interpretar el mensaje del usuario como otro pending.
   */
  skipPendingExtraction?: boolean;
}

/**
 * P0.2 (R-B): lectura fresca desde la DB, no `ctx.conversationState?.metadata`
 * (snapshot previo al turno). Sin esto, un payload `RESERVATION_SLOT:x`
 * persistido en el mismo turno no se veía hasta el turno siguiente.
 */
const buildReservationContextMessage = async (
  ctx: EnrichedContext,
  reservationCtx: ReservationAgentContext
): Promise<string> => {
  const userMsg = ctx.message?.text?.body ?? '';
  const customerName = (ctx.customer as { name?: string | null })?.name?.trim() || null;
  const conversationId = ctx.conversationId ?? '';

  // Fecha actual con día de semana — mismo reloj que el gate de la tool, para
  // que lo que el modelo lee acá y lo que el borde valida no puedan diferir.
  const businessTimezone = coerceIanaTimezone(ctx.business?.timezone);
  const dateLine = currentDateLabel(businessTimezone);

  const draft = conversationId ? await readReservationDraft(conversationId) : {};

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

  // Paso derivado (D5): única fuente de verdad del orden, ya no vive
  // duplicado entre el prompt y `nextReservationDraftQuestion`.
  const step = nextReservationStep(
    {
      date: draft.date,
      slotId: draft.slotId,
      partySize: draft.partySize,
      environmentId: draft.environmentId,
    },
    { hasEnvironments: reservationCtx.hasEnvironments }
  );

  const lines = [
    `[ESTADO DE LA RESERVA]`,
    `- Fecha actual: ${dateLine}`,
    `- Fecha elegida: ${dateLabel}`,
    `- Horario: ${slotLabel}`,
    `- Personas: ${partySizeLabel}`,
    `- Ambiente: ${environmentLabel}`,
    `- Nombre del cliente: ${customerName ?? 'no informado'}`,
    `- Paso actual: ${step}`,
    `- Acción esperada: ${expectedActionForReservationStep(step)}`,
  ];

  const pendingDishFaq = conversationId
    ? await readPendingReservationDishFaq(conversationId)
    : null;
  lines.push(
    ...buildPendingReservationDishFaqContextLines({
      pendingReservationDishFaq: pendingDishFaq ?? undefined,
      reservation_draft: { partySize: draft.partySize },
    })
  );

  // Catálogo id↔nombre: sin esto el ReAct no puede mapear "salón principal"
  // a un UUID para save_reservation_environment (la señal de UI no lo devuelve).
  if (reservationCtx.hasEnvironments && reservationCtx.environmentNames.length > 0) {
    lines.push(
      `- Ambientes disponibles: ${reservationCtx.environmentNames
        .map((e) => `${e.name} (id: ${e.id})`)
        .join('; ')}`
    );
    if (step === 'environment') {
      lines.push(
        '- Si el cliente nombra un ambiente fuera de esa lista: aclará que no está entre los del local ' +
          'y re-mostrá get_available_environments (o pedí elegir / sin preferencia); no inventes ids.'
      );
    }
  }

  const slotCatalog = reservationCtx.availableSlots ?? [];
  // Catálogo id↔horario: tipable / save_reservation_slot necesitan el UUID.
  if (step === 'slot' && slotCatalog.length > 0) {
    lines.push(
      `- Horarios disponibles: ${slotCatalog
        .map((s) => `${s.startTime}–${s.endTime} (id: ${s.id})`)
        .join('; ')}`
    );
    lines.push(
      '- Si el cliente nombra un horario fuera de esa lista: aclará que no está entre los ofrecidos ' +
        'y re-mostrá get_available_slots; no inventes slotId ni cambies de tema sin avisar.'
    );
  }

  // Tipables (slot / party_size / confirm / ambiente): el nodo ya short-circuitea fulfilled (§3.11).
  // Acá solo inyectamos el bloque para reprompt/delegate cuando el ReAct corre.
  const userText = userMsg.trim();
  const hasPayload = Boolean(ctx.payloadId?.trim());
  let extractionBlock = '';
  if (userText && !hasPayload && !reservationCtx.skipPendingExtraction) {
    try {
      if (step === 'slot' && slotCatalog.length > 0) {
        const extraction = await extractSelectSlotPending(userText, slotCatalog);
        console.log(
          JSON.stringify({
            event: '[reservation-pending] extraction',
            action: 'select_slot',
            status: extraction.status,
            confidence: extraction.confidence,
            source: extraction.source,
            conversationId,
          })
        );
        extractionBlock = formatPendingExtractionBlock({
          pendingAction: 'select_slot',
          botQuestion: SELECT_SLOT_QUESTION,
          status: extraction.status,
          confidence: extraction.confidence,
          value: extraction.value,
          reason: extraction.reason,
        });
      } else if (step === 'party_size') {
        const max = reservationCtx.maxPartySize ?? null;
        const extraction = await extractPartySizePending(userText, max);
        console.log(
          JSON.stringify({
            event: '[reservation-pending] extraction',
            action: 'party_size',
            status: extraction.status,
            confidence: extraction.confidence,
            source: extraction.source,
            conversationId,
          })
        );
        extractionBlock = formatPendingExtractionBlock({
          pendingAction: 'party_size',
          botQuestion: PARTY_SIZE_QUESTION,
          status: extraction.status,
          confidence: extraction.confidence,
          value: extraction.value,
          reason: extraction.reason,
        });
      } else if (step === 'confirm') {
        const extraction = await extractConfirmReservationPending(userText);
        console.log(
          JSON.stringify({
            event: '[reservation-pending] extraction',
            action: 'confirm_reservation',
            status: extraction.status,
            confidence: extraction.confidence,
            source: extraction.source,
            conversationId,
          })
        );
        extractionBlock = formatPendingExtractionBlock({
          pendingAction: 'confirm_reservation',
          botQuestion: CONFIRM_RESERVATION_QUESTION,
          status: extraction.status,
          confidence: extraction.confidence,
          value: extraction.value,
          reason: extraction.reason,
        });
      } else if (
        step === 'environment' &&
        reservationCtx.hasEnvironments &&
        reservationCtx.environmentNames.length > 0
      ) {
        const extraction = await extractSelectEnvironmentPending(
          userText,
          reservationCtx.environmentNames
        );
        console.log(
          JSON.stringify({
            event: '[reservation-pending] extraction',
            action: 'select_environment',
            status: extraction.status,
            confidence: extraction.confidence,
            source: extraction.source,
            conversationId,
          })
        );
        extractionBlock = formatPendingExtractionBlock({
          pendingAction: 'select_environment',
          botQuestion: SELECT_ENVIRONMENT_QUESTION,
          status: extraction.status,
          confidence: extraction.confidence,
          value: extraction.value,
          reason: extraction.reason,
        });
      }
    } catch (err) {
      console.error('[reservation-agent] error en extractPendingTurnResponse:', err);
    }
  }

  const contextParts = [lines.join('\n')];
  if (extractionBlock) {
    contextParts.push('', extractionBlock);
  }
  contextParts.push('', userMsg);
  return contextParts.join('\n');
};

// ---------------------------------------------------------------------------
// Extracción de señales del agente
// ---------------------------------------------------------------------------

export interface ReservationAgentSignals {
  presentSlots: boolean;
  presentSlotsDate: string | null;
  presentEnvironments: boolean;
  presentConfirmation: boolean;
  /** `null` = no se resolvió este turno; `true`/`false` = confirmó o canceló en texto (D3). */
  confirmReservationResolved: boolean | null;
  delegateToMain: boolean;
  delegateToMainReason: string | null;
  handbackReservation: boolean;
  handbackReservationReason: string | null;
  abandonReservation: boolean;
  abandonReservationReason: string | null;
}

const extractSignals = (messages: unknown[]): ReservationAgentSignals => {
  const signals: ReservationAgentSignals = {
    presentSlots: false,
    presentSlotsDate: null,
    presentEnvironments: false,
    presentConfirmation: false,
    confirmReservationResolved: null,
    delegateToMain: false,
    delegateToMainReason: null,
    handbackReservation: false,
    handbackReservationReason: null,
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
        confirmed?: boolean;
      };
      if (data.signal === 'resolve_reservation_confirmation') {
        signals.confirmReservationResolved = data.confirmed === true;
      }
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
      if (data.signal === 'handback_reservation') {
        signals.handbackReservation = true;
        signals.handbackReservationReason = data.reason ?? null;
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

  const contextMessage = await buildReservationContextMessage(ctx, reservationCtx);

  const history = await buildAgentHistoryMessages({
    conversationId,
    startedAt:
      typeof ctx.conversation === 'object' && ctx.conversation
        ? (ctx.conversation as { started_at?: Date }).started_at ?? null
        : null,
    currentMessageId: ctx.message?.id ?? null,
  });

  const inputs = {
    messages: [...history, new HumanMessage(contextMessage)],
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
