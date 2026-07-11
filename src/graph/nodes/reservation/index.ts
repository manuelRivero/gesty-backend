/**
 * Nodo LangGraph del agente de reservas dedicado.
 *
 * Captura todos los turnos mientras `metadata.reservation_agent_active` está
 * activo y los delega al `reservationAgent`.
 *
 * Responsabilidades del nodo (no del agente):
 *  - Activar `reservation_agent_active` en el primer turno.
 *  - Persistir slot/ambiente en `reservation_draft` cuando llegan payloads de botón.
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
import { buildListMessageFromButtons } from '../../../whatsappBuilders';
import { delegateToMainWithDetection } from '../session/delegateToMain';
import { buildResumeFollowUp } from '../session/buildResumeFollowUp';
import { buildDiscardedReentryMessage } from '../session/discardedSignalMessage';
import { withOrphanPayloadAsText } from '../session/orphanPayload';
import { findOrCreateConversationState } from '../../../repositories';
import {
  runReservationAgent,
  type ReservationAgentContext,
} from '../../../agents/reservationAgent';
import { normalizeMetadata } from '../../../services/productQuery/utils';
import type { HandlerFollowUp, HandlerResult } from '../../../controllers/webhook/types';
import type { EnrichedContext } from '../../../controllers/webhook/types';
import type { WhatsAppInteractiveMessage } from '../../../domain/intent/whatsappTemplates';
import type { AgentState, AgentStateUpdate } from '../../state';

// ---------------------------------------------------------------------------
// Helpers: limpiar sesión de reserva
// ---------------------------------------------------------------------------

const clearReservationSession = async (conversationId: string): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [
    'reservation_agent_active',
    'reservation_draft',
  ]);
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

function buildConfirmationButtonsMessage(
  data: ConfirmationData
): WhatsAppInteractiveMessage {
  const summary = [
    `📅 Fecha: ${data.date}`,
    `⏰ Horario: ${data.time}–${data.endTime}`,
    `👥 Personas: ${data.partySize}`,
    ...(data.environmentName ? [`🏡 Ambiente: ${data.environmentName}`] : []),
    ...(data.customerName ? [`👤 Nombre: ${data.customerName}`] : []),
  ].join('\n');

  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: {
        text: `🤖\n\n*Confirmá tu reserva* ✅\n\nRevisá los datos:\n\n${summary}`,
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
    const draft = wsMeta.reservation_draft;
    if (
      !draft?.date ||
      !draft?.slotId ||
      !draft?.time ||
      !draft?.endTime ||
      draft?.partySize == null
    ) {
      await clearReservationSession(conversationId);
      return {
        handlerResult: textResponse(
          '🤖\n\n*Error* ❌\n\nFaltaban datos de la reserva. Iniciá de nuevo cuando quieras.'
        ) ?? undefined,
        dataCollectionDelegated: true,
      };
    }

    try {
      const parsedDate = normalizeDate(draft.date);
      const slot = await fetchActiveReservationSlotById(draft.slotId, business.id);
      if (!slot) {
        return {
          handlerResult: textResponse(
            '🤖\n\n*Horario no disponible* ❌\n\nEl horario elegido ya no está disponible. Empecemos de nuevo para elegir otro.'
          ) ?? undefined,
          dataCollectionDelegated: true,
        };
      }

      const startDateTime = buildDateTime(parsedDate, slot.start_time);
      const endDateTime = buildDateTime(parsedDate, slot.end_time);

      // Buscar mesas disponibles
      const tables = await findActiveTablesByBusinessAndEnvironment(
        business.id,
        draft.environmentId ?? undefined
      );
      const suitable = tables.filter((t) => t.capacity >= draft.partySize!);
      const availableTables: typeof suitable = [];
      for (const table of suitable) {
        const overlap = await findOverlappingReservationForTable(
          table.id,
          parsedDate,
          startDateTime
        );
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
        return {
          handlerResult: textResponse(
            '🤖\n\n*Sin disponibilidad* ❌\n\nYa no hay mesas disponibles para esa fecha y horario. Intentá con otra fecha u horario.'
          ) ?? undefined,
          dataCollectionDelegated: true,
        };
      }

      const created = await createReservationWithTables({
        businessId: business.id,
        customerId,
        conversationId,
        partySize: draft.partySize,
        reservationDate: parsedDate,
        startDateTime,
        endDateTime,
        tableIds: selected.map((t) => t.id),
      });

      await clearReservationSession(conversationId);

      // Generar QR
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
        handlerResult: {
          content: successText,
          isInteractive: false,
          ...(followUps ? { followUps } : {}),
        },
        dataCollectionDelegated: true,
      };
    } catch (err) {
      const isConflict =
        err instanceof Error && err.message === 'TABLES_ALREADY_BOOKED';
      await clearReservationSession(conversationId);
      return {
        handlerResult: textResponse(
          isConflict
            ? '🤖\n\n*Mesa ocupada* ❌\n\nAlguien acaba de reservar esa mesa. Iniciá de nuevo para elegir otro horario o fecha.'
            : '🤖\n\n*Error al confirmar* ❌\n\nHubo un problema al crear la reserva. Intentá de nuevo en unos minutos.'
        ) ?? undefined,
        dataCollectionDelegated: true,
      };
    }
  }

  // ── RESERVATION_CANCEL — limpiar sesión o cancelar reserva activa ─────────
  if (payloadId === 'RESERVATION_CANCEL') {
    await clearReservationSession(conversationId);
    // Si el draft tenía una reserva existente en DB, cancelarla
    // (esto aplica cuando se está gestionando una reserva preexistente)
    return {
      handlerResult: textResponse(
        '🤖\n\n*Reserva cancelada* 👋\n\nNo hay problema. Avisame si querés hacer una reserva en otro momento.'
      ) ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  // ── RESERVATION_RESET — limpiar draft y reiniciar con el agente ───────────
  if (payloadId === 'RESERVATION_RESET') {
    await omitConversationMetadataKeys(conversationId, ['reservation_draft']);
    // Sigue al bloque de invocación del agente
  }

  // ── Payloads de botón: RESERVATION_SLOT:{id} ─────────────────────────────
  if (payloadId?.startsWith('RESERVATION_SLOT:')) {
    const slotId = payloadId.split(':')[1];
    const slot = await fetchActiveReservationSlotById(slotId, business.id);
    if (slot) {
      const currentDraft = wsMeta.reservation_draft ?? {};
      await patchConversationMetadata(conversationId, {
        reservation_draft: {
          ...currentDraft,
          slotId: slot.id,
          time: slot.start_time,
          endTime: slot.end_time,
        },
      });
    }
    // Continúa al agente con metadata actualizada (el ctx ya trae conversationState anterior)
    // El agente verá el slot en [ESTADO DE LA RESERVA] del próximo turno al invocar.
    // Para el turno actual, refrescamos el estado local.
    if (slot && state.workingConversationState?.metadata) {
      const m = normalizeMetadata(state.workingConversationState.metadata);
      m.reservation_draft = { ...(m.reservation_draft ?? {}), slotId: slot.id, time: slot.start_time, endTime: slot.end_time };
    }
  }

  // ── Payloads de botón: RESERVATION_ENV:{id} o RESERVATION_ENV_NONE ───────
  if (payloadId?.startsWith('RESERVATION_ENV:')) {
    const envId = payloadId.split(':')[1];
    const currentDraft = wsMeta.reservation_draft ?? {};
    await patchConversationMetadata(conversationId, {
      reservation_draft: { ...currentDraft, environmentId: envId },
    });
  }
  if (payloadId === 'RESERVATION_ENV_NONE') {
    const currentDraft = wsMeta.reservation_draft ?? {};
    await patchConversationMetadata(conversationId, {
      reservation_draft: { ...currentDraft, environmentId: null },
    });
  }

  // ── Activar sesión en el primer turno ────────────────────────────────────
  if (!wsMeta.reservation_agent_active && payloadId !== 'RESERVATION_RESET') {
    await patchConversationMetadata(conversationId, {
      reservation_agent_active: true,
    });
  }

  // ── Obtener ambientes disponibles ─────────────────────────────────────────
  const environments = await findActiveEnvironmentsByBusinessId(business.id);
  const reservationCtx: ReservationAgentContext = {
    hasEnvironments: environments.length > 0,
    environmentNames: environments.map((e) => ({ id: e.id, name: e.name })),
  };

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

  // ── Señal: mostrar confirmación ───────────────────────────────────────────
  if (signals.presentConfirmation) {
    // Leer draft actualizado de la DB
    const freshState = await prisma.conversation_state.findFirst({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    const freshMeta = normalizeMetadata(freshState?.metadata);
    const draft = freshMeta.reservation_draft;

    if (!draft?.date || !draft?.time || !draft?.endTime || draft?.partySize == null) {
      return {
        handlerResult: { content: text, isInteractive: false },
        dataCollectionDelegated: true,
      };
    }

    const environmentName = await resolveEnvironmentName(
      draft.environmentId,
      business.id
    );

    const confirmationMsg = buildConfirmationButtonsMessage({
      date: draft.date,
      time: draft.time,
      endTime: draft.endTime,
      partySize: draft.partySize,
      environmentName,
      customerName: customerName ?? undefined,
    });

    const followUp: HandlerFollowUp = {
      type: 'interactive',
      message: confirmationMsg as any,
    };

    return {
      handlerResult: {
        content: text,
        isInteractive: false,
        followUps: [followUp],
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
