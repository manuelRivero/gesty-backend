/**
 * Nodo LangGraph del agente de reservas dedicado.
 *
 * Captura todos los turnos mientras `metadata.reservation_agent_active` está
 * activo y los delega al `reservationAgent`.
 *
 * Responsabilidades del nodo (no del agente):
 *  - Activar `reservation_agent_active` en el primer turno.
 *  - Persistir slot/ambiente en `reservation_draft` cuando llegan payloads de botón.
 *  - Tipables fulfilled (§3.11): ambiente y confirmación en prosa → mismo efecto
 *    que el botón, ANTES del ReAct (`extractPendingTurnResponse`).
 *  - Ejecutar la confirmación determinística (createReservationWithTables + QR).
 *  - Manejar RESERVATION_CANCEL y RESERVATION_RESET.
 *  - Adjuntar listas/botones WhatsApp cuando el agente devuelve señales.
 *  - Llamar runHybridReactAgent inline para señal delegate_to_main sin limpiar sesión.
 */

import { prisma } from '../../../lib/prisma';
import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../../../repositories/conversationState.repository';
import { textResponse, interactiveResponse } from '../../../controllers/webhook/utils';
import {
  fetchReservationSlotsForBusinessDate,
  fetchActiveReservationSlotById,
  findActiveEnvironmentsByBusinessId,
  findActiveTablesByBusinessAndEnvironment,
  findOverlappingReservationForTable,
  findReservationBlockAtStart,
  createReservationWithTables,
  updateReservationStatus,
  findAnyFutureOccupyingReservationForCustomer,
} from '../../../repositories/reservation.repository';
import { generateReservationQR } from '../../../utils/reservationQr';
import {
  buildDateTime,
  normalizeDate,
  selectTables,
  formatReservationDateDb,
  formatDbTimeReservation,
} from '../../../services/reservations/utils';
import {
  patchReservationDraft,
  readReservationDraft,
  type ReservationDraftData,
} from '../../../services/reservations/draft.repository';
import { nextReservationStep } from '../../../services/reservations/nextReservationStep';
import { buildListMessageFromButtons } from '../../../whatsappBuilders';
import { delegateToMainWithDetection } from '../session/delegateToMain';
import { buildResumeFollowUp } from '../session/buildResumeFollowUp';
import { buildDiscardedReentryMessage } from '../session/discardedSignalMessage';
import { withOrphanPayloadAsText } from '../session/orphanPayload';
import { findOrCreateConversationState } from '../../../repositories';
import {
  runReservationAgent,
  extractConfirmReservationPending,
  extractSelectEnvironmentPending,
  isValidEnvironmentSelection,
  type ReservationAgentContext,
} from '../../../agents/reservationAgent';
import { runHybridReactAgent } from '../../../agents/reactAgent';
import { detectIntentWithConfidence } from '../../../services/ai/detection.service';
import { isHybridAgentMode } from '../../../config/env';
import {
  formatBotUserMessage,
  normalizeMetadata,
} from '../../../services/productQuery/utils';
import {
  getReservationCompletionLedger,
  reviveReservationCompletionIfAbandoned,
} from '../../../services/reservationCompletionGoal.service';
import type { HandlerFollowUp, HandlerResult } from '../../../controllers/webhook/types';
import type { EnrichedContext } from '../../../controllers/webhook/types';
import type { WhatsAppInteractiveMessage } from '../../../domain/intent/whatsappTemplates';
import type { AgentState, AgentStateUpdate } from '../../state';
import type { DetectionContext } from '../../../services/ai/detection.service';

// ---------------------------------------------------------------------------
// Helpers: limpiar sesión de reserva
// ---------------------------------------------------------------------------

const clearReservationSession = async (conversationId: string): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [
    'reservation_agent_active',
    'reservation_draft',
  ]);
};

/**
 * Salida temporal (Fase 1b): a diferencia de `clearReservationSession`, NO
 * borra `reservation_draft` — es lo que permite que `COMPLETAR_RESERVA`
 * pueda reabrirse más adelante (ver `reservationCompletionGoal.service.ts`).
 */
const clearReservationAgentOnly = async (conversationId: string): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, ['reservation_agent_active']);
};

/** Mismo patrón que `invokeHybridAfterCheckoutHandback` en checkout. */
const invokeHybridAfterReservationHandback = async (params: {
  enrichedCtx: EnrichedContext;
  conversationId: string;
  detectionContext: DetectionContext;
  userMessage: string;
}): Promise<HandlerResult | null> => {
  if (!isHybridAgentMode() || !params.userMessage.trim()) {
    return null;
  }

  const detection = await detectIntentWithConfidence(
    params.userMessage,
    params.detectionContext
  );
  const refreshedState = await findOrCreateConversationState(params.conversationId);
  const hybridCtx: EnrichedContext = {
    ...params.enrichedCtx,
    detection,
    conversationState: refreshedState,
  };

  try {
    const hybrid = await runHybridReactAgent(hybridCtx);
    if (hybrid?.kind === 'response') {
      return hybrid.handlerResult;
    }
    return null;
  } catch (err) {
    console.error('[reservation-agent] error en handback inline hybrid:', err);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Helper: construir mensaje de confirmación con botones
// ---------------------------------------------------------------------------

interface ConfirmationData {
  date: string;
  time: string;
  endTime: string;
  partySize: number;
  environmentName?: string;
  customerName?: string;
}

/**
 * D4: el texto del LLM va como *body* del interactivo, no como mensaje
 * separado + followUp — un solo mensaje, sin redacción propia del resumen.
 */
function buildConfirmationButtonsMessage(
  data: ConfirmationData,
  leadText?: string | null
): WhatsAppInteractiveMessage {
  const summary = [
    `📅 Fecha: ${data.date}`,
    `⏰ Horario: ${data.time}–${data.endTime}`,
    `👥 Personas: ${data.partySize}`,
    ...(data.environmentName ? [`🏡 Ambiente: ${data.environmentName}`] : []),
    ...(data.customerName ? [`👤 Nombre: ${data.customerName}`] : []),
  ].join('\n');

  const lead = leadText?.trim() ? `${leadText.trim()}\n\n` : '🤖\n\n';

  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: `${lead}*Confirmá tu reserva* ✅\n\nRevisá los datos:\n\n${summary}`,
      },
      footer: { text: 'Seleccioná una opción' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'RESERVATION_CONFIRM', title: '✅ Confirmar' } },
          { type: 'reply', reply: { id: 'RESERVATION_CANCEL', title: '❌ Cancelar' } },
        ],
      },
    },
  } as WhatsAppInteractiveMessage;
}

// ---------------------------------------------------------------------------
// Helper: encontrar nombre de ambiente
// ---------------------------------------------------------------------------

async function resolveEnvironmentName(
  environmentId: string | null | undefined,
  businessId: string
): Promise<string | undefined> {
  if (!environmentId) return undefined;
  const env = await prisma.environment.findUnique({
    where: { id: environmentId },
    select: { name: true },
  });
  return env?.name ?? undefined;
}

// ---------------------------------------------------------------------------
// Confirmación / cancelación — una sola función por canal (V-20, P1.2)
// ---------------------------------------------------------------------------

/**
 * Crea la reserva a partir del draft. La usan por igual el payload de botón
 * `RESERVATION_CONFIRM` y la señal `resolve_reservation_confirmation(true)`
 * en texto libre — una sola fuente de verdad de "qué pasa al confirmar".
 */
async function executeReservationConfirmation(params: {
  conversationId: string;
  businessId: string;
  customerId: string;
  customerName: string | null;
  draft: ReservationDraftData | undefined;
}): Promise<HandlerResult> {
  const { conversationId, businessId, customerId, customerName, draft } = params;

  if (!draft?.date || !draft?.slotId || !draft?.time || !draft?.endTime || draft?.partySize == null) {
    await clearReservationSession(conversationId);
    return (
      textResponse(
        '🤖\n\n*Error* ❌\n\nFaltaban datos de la reserva. Iniciá de nuevo cuando quieras.'
      ) ?? { content: '', isInteractive: false }
    );
  }

  try {
    const parsedDate = normalizeDate(draft.date);
    const slot = await fetchActiveReservationSlotById(draft.slotId, businessId);
    if (!slot) {
      return (
        textResponse(
          '🤖\n\n*Horario no disponible* ❌\n\nEl horario elegido ya no está disponible. Empecemos de nuevo para elegir otro.'
        ) ?? { content: '', isInteractive: false }
      );
    }

    const startDateTime = buildDateTime(parsedDate, slot.start_time);
    const endDateTime = buildDateTime(parsedDate, slot.end_time);

    const tables = await findActiveTablesByBusinessAndEnvironment(
      businessId,
      draft.environmentId ?? undefined
    );
    const suitable = tables.filter((t) => t.capacity >= draft.partySize!);
    const availableTables: typeof suitable = [];
    for (const table of suitable) {
      const overlap = await findOverlappingReservationForTable(table.id, parsedDate, startDateTime);
      if (overlap) continue;
      const block = await findReservationBlockAtStart(
        table.id,
        draft.environmentId ?? null,
        parsedDate,
        startDateTime
      );
      if (block) continue;
      availableTables.push(table);
    }

    const selected = selectTables(availableTables, draft.partySize);
    if (!selected) {
      return (
        textResponse(
          '🤖\n\n*Sin disponibilidad* ❌\n\nYa no hay mesas disponibles para esa fecha y horario. Intentá con otra fecha u horario.'
        ) ?? { content: '', isInteractive: false }
      );
    }

    const created = await createReservationWithTables({
      businessId,
      customerId,
      conversationId,
      partySize: draft.partySize,
      reservationDate: parsedDate,
      startDateTime,
      endDateTime,
      tableIds: selected.map((t) => t.id),
    });

    await clearReservationSession(conversationId);

    const dateStr = formatReservationDateDb(created.reservation_date);
    const timeStr = formatDbTimeReservation(created.start_time as Date);
    const successText = [
      `🤖\n\n*¡Reserva confirmada!* 🎉`,
      ``,
      `📅 ${dateStr}`,
      `⏰ ${timeStr}`,
      `👥 ${created.party_size}`,
      ...(customerName ? [`👤 ${customerName}`] : []),
      ``,
      `¡Te esperamos! 😊`,
    ].join('\n');

    let followUps: HandlerResult['followUps'];
    try {
      const checkinToken = (created as unknown as { checkin_token: string }).checkin_token;
      const qrDataUrl = await generateReservationQR(checkinToken);
      followUps = [{ type: 'image', dataUrl: qrDataUrl } as HandlerFollowUp];
    } catch {
      console.error('[reservation-agent] No se pudo generar el QR');
    }

    return {
      content: successText,
      isInteractive: false,
      ...(followUps ? { followUps } : {}),
    };
  } catch (err) {
    const isConflict = err instanceof Error && err.message === 'TABLES_ALREADY_BOOKED';
    await clearReservationSession(conversationId);
    return (
      textResponse(
        isConflict
          ? '🤖\n\n*Mesa ocupada* ❌\n\nAlguien acaba de reservar esa mesa. Iniciá de nuevo para elegir otro horario o fecha.'
          : '🤖\n\n*Error al confirmar* ❌\n\nHubo un problema al crear la reserva. Intentá de nuevo en unos minutos.'
      ) ?? { content: '', isInteractive: false }
    );
  }
}

/** La usan por igual `RESERVATION_CANCEL` y `resolve_reservation_confirmation(false)`. */
async function executeReservationCancellation(conversationId: string): Promise<HandlerResult> {
  await clearReservationSession(conversationId);
  return (
    textResponse(
      '🤖\n\n*Reserva cancelada* 👋\n\nNo hay problema. Avisame si querés hacer una reserva en otro momento.'
    ) ?? { content: '', isInteractive: false }
  );
}

// ---------------------------------------------------------------------------
// Nodo principal
// ---------------------------------------------------------------------------

export const reservationAgentNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const enrichedBase = state.enrichedCtx as unknown as EnrichedContext;
  const conversation = state.conversation!;
  const business = state.business!;
  const customer = state.customer!;
  const payloadId = ctx.payloadId;
  const conversationId = conversation.id;
  const customerId = customer.id;
  const customerName = (customer as { name?: string | null })?.name ?? null;

  const wsMeta = normalizeMetadata(state.workingConversationState?.metadata);

  // ── RESERVATION_CONFIRM — flujo determinístico de creación ────────────────
  if (payloadId === 'RESERVATION_CONFIRM') {
    const handlerResult = await executeReservationConfirmation({
      conversationId,
      businessId: business.id,
      customerId,
      customerName,
      draft: wsMeta.reservation_draft,
    });
    return { handlerResult, dataCollectionDelegated: true };
  }

  // ── RESERVATION_CANCEL — limpiar sesión ───────────────────────────────────
  if (payloadId === 'RESERVATION_CANCEL') {
    const handlerResult = await executeReservationCancellation(conversationId);
    return { handlerResult, dataCollectionDelegated: true };
  }

  // ── RESERVATION_RESET — limpiar draft y reiniciar con el agente ───────────
  if (payloadId === 'RESERVATION_RESET') {
    await omitConversationMetadataKeys(conversationId, ['reservation_draft']);
    // Sigue al bloque de invocación del agente
  }

  // ── Payloads de botón: RESERVATION_SLOT:{id} ─────────────────────────────
  // P0.2 (R-B): el merge queda persistido en DB; el agente lo lee con
  // lectura fresca en buildReservationContextMessage — ya no hace falta
  // "refrescar" ningún objeto local (ese bloque no mutaba nada).
  if (payloadId?.startsWith('RESERVATION_SLOT:')) {
    const slotId = payloadId.split(':')[1];
    const slot = await fetchActiveReservationSlotById(slotId, business.id);
    if (slot) {
      await patchReservationDraft(conversationId, {
        slotId: slot.id,
        time: slot.start_time,
        endTime: slot.end_time,
      });
    }
  }

  // ── Payloads de botón: RESERVATION_ENV:{id} o RESERVATION_ENV_NONE ───────
  if (payloadId?.startsWith('RESERVATION_ENV:')) {
    const envId = payloadId.split(':')[1];
    await patchReservationDraft(conversationId, { environmentId: envId });
  }
  if (payloadId === 'RESERVATION_ENV_NONE') {
    await patchReservationDraft(conversationId, { environmentId: null });
  }

  // ── Activar sesión en el primer turno ────────────────────────────────────
  if (!wsMeta.reservation_agent_active && payloadId !== 'RESERVATION_RESET') {
    await patchConversationMetadata(conversationId, {
      reservation_agent_active: true,
    });
    // Revival del Goal COMPLETAR_RESERVA (ADR-0005, corolario): si el
    // cliente había abandonado la reserva y vuelve a esta sesión, el
    // abandono se limpia solo — retomarla es la señal de reactivación.
    await reviveReservationCompletionIfAbandoned(
      conversationId,
      getReservationCompletionLedger(wsMeta)
    );
  }

  // ── Obtener ambientes disponibles ─────────────────────────────────────────
  const environments = await findActiveEnvironmentsByBusinessId(business.id);
  const envCatalog = environments.map((e) => ({ id: e.id, name: e.name }));
  const reservationCtx: ReservationAgentContext = {
    hasEnvironments: environments.length > 0,
    environmentNames: envCatalog,
  };

  // ── Tipables fulfilled en el nodo (§3.11) — ANTES del ReAct ───────────────
  // Mismo borde que el botón: extractPendingTurnResponse → efecto, sin esperar
  // a que el modelo llame resolve_* / save_reservation_environment.
  const tipableText = ctx.message?.text?.body?.trim() ?? '';
  const tipableMessageType = ctx.message?.type;
  if (tipableText && !payloadId && tipableMessageType !== 'location') {
    const tipableDraft = await readReservationDraft(conversationId);
    const tipableStep = nextReservationStep(
      {
        date: tipableDraft.date,
        slotId: tipableDraft.slotId,
        partySize: tipableDraft.partySize,
        environmentId: tipableDraft.environmentId,
      },
      { hasEnvironments: environments.length > 0 }
    );

    if (tipableStep === 'environment' && environments.length > 0) {
      const extraction = await extractSelectEnvironmentPending(tipableText, envCatalog);
      console.log(
        JSON.stringify({
          event: '[reservation-agent] select_environment_tipable_extraction',
          status: extraction.status,
          confidence: extraction.confidence,
          source: extraction.source,
          conversationId,
        })
      );
      if (
        extraction.status === 'fulfilled' &&
        extraction.value &&
        isValidEnvironmentSelection(extraction.value.environmentId, envCatalog)
      ) {
        await patchReservationDraft(conversationId, {
          environmentId: extraction.value.environmentId,
        });
        const freshDraft = await readReservationDraft(conversationId);
        if (
          freshDraft.date &&
          freshDraft.time &&
          freshDraft.endTime &&
          freshDraft.partySize != null
        ) {
          const environmentName = await resolveEnvironmentName(
            freshDraft.environmentId,
            business.id
          );
          const envLabel =
            extraction.value.environmentId === null
              ? 'sin preferencia'
              : environmentName ?? 'ambiente elegido';
          const ack = formatBotUserMessage(
            'Ambiente',
            '🏡',
            `Listo, anoté *${envLabel}*.`
          );
          const confirmationMsg = buildConfirmationButtonsMessage(
            {
              date: freshDraft.date,
              time: freshDraft.time,
              endTime: freshDraft.endTime,
              partySize: freshDraft.partySize,
              environmentName,
              customerName: customerName ?? undefined,
            },
            ack
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
        // Draft sin time/endTime: seguir al ReAct sin re-extraer el tipable.
        reservationCtx.skipPendingExtraction = true;
      }
    } else if (tipableStep === 'confirm') {
      const extraction = await extractConfirmReservationPending(tipableText);
      console.log(
        JSON.stringify({
          event: '[reservation-agent] confirm_tipable_extraction',
          status: extraction.status,
          confidence: extraction.confidence,
          source: extraction.source,
          conversationId,
        })
      );
      if (extraction.status === 'fulfilled' && extraction.value) {
        const freshDraft = await readReservationDraft(conversationId);
        const handlerResult = extraction.value.confirmed
          ? await executeReservationConfirmation({
              conversationId,
              businessId: business.id,
              customerId,
              customerName,
              draft: freshDraft,
            })
          : await executeReservationCancellation(conversationId);
        return { handlerResult, dataCollectionDelegated: true };
      }
    }
  }

  // Payload interactivo huérfano (H-09): con `reservation_agent_active` este
  // nodo captura CUALQUIER interactivo, no solo `RESERVATION_*` — un botón/lista
  // vieja (ej. `ADD_ITEM:x` de un CTA anterior) llegaría con `userMsg=''` y el
  // agente respondería a ciegas, perdiendo la acción tocada.
  const KNOWN_RESERVATION_PAYLOADS = new Set(['RESERVATION_CONFIRM', 'RESERVATION_CANCEL', 'RESERVATION_RESET', 'RESERVATION_ENV_NONE']);
  const isKnownReservationPayload =
    Boolean(payloadId) &&
    (KNOWN_RESERVATION_PAYLOADS.has(payloadId as string) ||
      payloadId!.startsWith('RESERVATION_SLOT:') ||
      payloadId!.startsWith('RESERVATION_ENV:'));
  const agentCtx =
    payloadId && !isKnownReservationPayload ? withOrphanPayloadAsText(enrichedBase) : enrichedBase;

  // ── Invocar el agente de reservas ─────────────────────────────────────────
  let agentResult: Awaited<ReturnType<typeof runReservationAgent>>;
  try {
    agentResult = await runReservationAgent(agentCtx, reservationCtx);
  } catch (err) {
    console.error('[reservation-agent] error invocando el agente:', err);
    agentResult = null;
  }

  if (!agentResult) {
    return {
      handlerResult: textResponse(
        '🤖\n\n*Hubo un problema* 😔\n\nNo pude procesar tu reserva en este momento. ¿Podés intentarlo de nuevo?'
      ) ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  const { text, signals } = agentResult;

  // ── Señal: delegar turno al agente principal (off-topic temporal) ─────────
  if (signals.delegateToMain) {
    console.log(
      JSON.stringify({
        event: '[reservation-agent] delegate_to_main',
        reason: signals.delegateToMainReason,
        conversationId,
      })
    );
    // Llamar al agente principal inline; reservation_agent_active NO se limpia
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
      console.error('[reservation-agent] error en delegate_to_main:', err);
    }

    if (discardedReentrySignal) {
      console.log(
        JSON.stringify({
          event: '[reservation-agent] delegation_signal_discarded',
          conversationId,
        })
      );
      return {
        handlerResult: { content: buildDiscardedReentryMessage('reservation'), isInteractive: false },
        dataCollectionDelegated: true,
      };
    }

    const baseResult = mainResult ?? { content: text, isInteractive: false };

    // Anexar (no reemplazar) la pregunta del paso pendiente de la reserva,
    // si la hay, para que el usuario no tenga que retomarla por su cuenta (H-03/H-05).
    const freshState = await findOrCreateConversationState(conversationId);
    const freshMeta = normalizeMetadata(freshState.metadata);
    const resume = buildResumeFollowUp({
      kind: 'reservation',
      draft: freshMeta.reservation_draft,
      hasEnvironments: environments.length > 0,
    });

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

  // ── Señal: handback temporal (conserva el borrador) ───────────────────────
  if (signals.handbackReservation) {
    await clearReservationAgentOnly(conversationId);
    console.log(
      JSON.stringify({
        event: '[reservation-agent] handback_reservation',
        reason: signals.handbackReservationReason,
        conversationId,
      })
    );

    const userMessage = ctx.message?.text?.body?.trim() ?? '';
    const detectionContext = state.detectionContext;
    let hybridResult: HandlerResult | null = null;
    if (detectionContext && userMessage) {
      hybridResult = await invokeHybridAfterReservationHandback({
        enrichedCtx: enrichedBase,
        conversationId,
        detectionContext,
        userMessage,
      });
    }
    if (hybridResult) {
      console.log(
        JSON.stringify({
          event: '[reservation-agent] handback_inline_hybrid',
          conversationId,
        })
      );
    }

    return {
      handlerResult: hybridResult ?? { content: text, isInteractive: false },
      dataCollectionDelegated: true,
    };
  }

  // ── Señal: abandonar reserva (permanente) ────────────────────────────────
  if (signals.abandonReservation) {
    await clearReservationSession(conversationId);
    console.log(
      JSON.stringify({
        event: '[reservation-agent] abandon_reservation',
        reason: signals.abandonReservationReason,
        conversationId,
      })
    );
    return {
      handlerResult: { content: text, isInteractive: false },
      dataCollectionDelegated: true,
    };
  }

  // ── Señal: confirmación en texto libre (D3) ──────────────────────────────
  // Misma función que RESERVATION_CONFIRM/RESERVATION_CANCEL, sin importar
  // el canal (V-20): "sí, confirmo" en texto ya no queda sin salida (R-C).
  if (signals.confirmReservationResolved !== null) {
    const freshDraft = await readReservationDraft(conversationId);
    console.log(
      JSON.stringify({
        event: '[reservation-agent] resolve_reservation_confirmation',
        confirmed: signals.confirmReservationResolved,
        conversationId,
      })
    );
    const handlerResult = signals.confirmReservationResolved
      ? await executeReservationConfirmation({
          conversationId,
          businessId: business.id,
          customerId,
          customerName,
          draft: freshDraft,
        })
      : await executeReservationCancellation(conversationId);
    return { handlerResult, dataCollectionDelegated: true };
  }

  // ── Señal: mostrar lista de horarios disponibles ───────────────────────────
  if (signals.presentSlots && signals.presentSlotsDate) {
    try {
      const parsedDate = normalizeDate(signals.presentSlotsDate);
      const slots = await fetchReservationSlotsForBusinessDate(business.id, parsedDate);
      if (slots.length === 0) {
        return {
          handlerResult: {
            content: `${text}\n\n_No hay horarios disponibles para esa fecha. Probá con otra._`,
            isInteractive: false,
          },
          dataCollectionDelegated: true,
        };
      }

      const slotList = buildListMessageFromButtons(
        text,
        slots.map((slot) => ({
          title: slot.start_time,
          payload: `RESERVATION_SLOT:${slot.id}`,
          description: `${slot.start_time} – ${slot.end_time}`,
          sectionTitle: 'Horarios disponibles',
        })),
        'Ver horarios',
        '',
        'Elegí un horario'
      );
      return {
        handlerResult: { content: slotList, isInteractive: true },
        dataCollectionDelegated: true,
      };
    } catch {
      return {
        handlerResult: { content: text, isInteractive: false },
        dataCollectionDelegated: true,
      };
    }
  }

  // ── Señal: mostrar lista de ambientes ────────────────────────────────────
  if (signals.presentEnvironments) {
    const buttons = [
      ...environments.map((env) => ({
        title: env.name,
        payload: `RESERVATION_ENV:${env.id}`,
        description: '',
        sectionTitle: 'Ambientes',
      })),
      {
        title: 'Sin preferencia',
        payload: 'RESERVATION_ENV_NONE',
        description: 'Cualquier ambiente',
        sectionTitle: 'Ambientes',
      },
    ];

    const envList = buildListMessageFromButtons(
      text,
      buttons,
      'Ver ambientes',
      '',
      'Elegí un ambiente'
    );
    return {
      handlerResult: { content: envList, isInteractive: true },
      dataCollectionDelegated: true,
    };
  }

  // ── Señal o backup por estado: mostrar confirmación (D4) ─────────────────
  // La tarjeta sale con o sin señal del LLM: si el paso derivado es
  // `confirm` y el draft está completo, se adjunta igual — mismo criterio
  // que checkout (V-25) y onboarding (V-24). Un solo mensaje, con el texto
  // del agente como body (no content + followUp — V-19/R-D).
  const freshDraftForConfirm = await readReservationDraft(conversationId);
  const derivedStep = nextReservationStep(
    {
      date: freshDraftForConfirm.date,
      slotId: freshDraftForConfirm.slotId,
      partySize: freshDraftForConfirm.partySize,
      environmentId: freshDraftForConfirm.environmentId,
    },
    { hasEnvironments: environments.length > 0 }
  );
  const shouldPresentConfirmation = signals.presentConfirmation || derivedStep === 'confirm';

  if (shouldPresentConfirmation) {
    const draft = freshDraftForConfirm;

    if (!draft?.date || !draft?.time || !draft?.endTime || draft?.partySize == null) {
      return {
        handlerResult: { content: text, isInteractive: false },
        dataCollectionDelegated: true,
      };
    }

    const environmentName = await resolveEnvironmentName(draft.environmentId, business.id);

    const confirmationMsg = buildConfirmationButtonsMessage(
      {
        date: draft.date,
        time: draft.time,
        endTime: draft.endTime,
        partySize: draft.partySize,
        environmentName,
        customerName: customerName ?? undefined,
      },
      text
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

  // ── Solo texto (pide dato faltante o da información) ─────────────────────
  return {
    handlerResult: { content: text, isInteractive: false },
    dataCollectionDelegated: true,
  };
};
