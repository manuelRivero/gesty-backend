/**
 * Nodo LangGraph del agente de reservas dedicado.
 *
 * Captura todos los turnos mientras `metadata.reservation_agent_active` está
 * activo y los delega al `reservationAgent`.
 *
 * Responsabilidades del nodo (no del agente):
 *  - Activar `reservation_agent_active` en el primer turno.
 *  - Persistir slot/ambiente en `reservation_draft` cuando llegan payloads de botón.
 *  - Tipables fulfilled (§3.11): horario, personas, ambiente y confirmación en prosa
 *    → mismo efecto que el botón/tool, ANTES del ReAct (`extractPendingTurnResponse`).
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
import { formatDraftDateWithWeekday } from '../../../services/reservations/clock';
import {
  patchReservationDraft,
  readReservationDraft,
  type ReservationDraftData,
} from '../../../services/reservations/draft.repository';
import { nextReservationStep } from '../../../services/reservations/nextReservationStep';
import { clearReservationSessionAfterCancel } from '../../../services/reservationSessionReset.service';
import {
  ASK_RESERVATION_PARTY_SIZE_FOR_DISHES,
  shouldBlockDishFaqWithoutPartySize,
} from '../../../services/reservations/dishFaqPartySizeGate';
import {
  PENDING_RESERVATION_DISH_FAQ_KEY,
  buildPendingReservationDishFaq,
  clearPendingReservationDishFaq,
  dishFaqDelegationReasonForPartySize,
  dishFaqUserMessageForHybrid,
  readPendingReservationDishFaq,
  shouldFulfillReservationDishFaq,
  withDishFaqEnrichedContext,
  type PendingReservationDishFaq,
} from '../../../services/reservations/pendingReservationDishFaq';
import { resolveDomainCancelCommand } from '../../../services/domainCancelCommand.service';
import { buildCancelOrderMessage } from '../../../services/order.service';
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
  extractSelectSlotPending,
  extractPartySizePending,
  isValidEnvironmentSelection,
  isValidSlotSelection,
  isValidPartySizeSelection,
  type ReservationAgentContext,
} from '../../../agents/reservationAgent';
import { getMaxCombinablePartySize } from '../../../services/reservations/capacity';
import {
  buildReservationFaqDelegation,
  RESERVATION_FAQ_DELEGATION_KEY,
} from '../../../services/reservationFaqDelegation.service';
import { runHybridReactAgent } from '../../../agents/reactAgent';
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

/** Cancel / abandon / post-confirm: wipe de sesión de reserva + Ledger. */
/** Cancel / abandon / post-confirm: wipe de sesión de reserva + Ledger. */
const clearReservationSession = async (conversationId: string): Promise<void> => {
  await clearReservationSessionAfterCancel(conversationId);
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
  if (!params.userMessage.trim()) {
    return null;
  }

  const refreshedState = await findOrCreateConversationState(params.conversationId);
  const hybridCtx: EnrichedContext = {
    ...params.enrichedCtx,
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
  const dateLabel = formatDraftDateWithWeekday(data.date);
  const summary = [
    `📅 Fecha: ${dateLabel}`,
    `⏰ Horario: ${data.time}–${data.endTime}`,
    `👥 Personas: ${data.partySize}`,
    ...(data.environmentName ? [`🏡 Ambiente: ${data.environmentName}`] : []),
    ...(data.customerName ? [`👤 Nombre: ${data.customerName}`] : []),
  ].join('\n');

  // Lead corto sí; si el LLM reescribió el resumen entero (con weekday inventado),
  // no lo anteponemos: la tarjeta determinística es la fuente de verdad.
  const trimmedLead = leadText?.trim() ?? '';
  const leadRestatesSummary =
    /fecha\s*:/i.test(trimmedLead) ||
    /horario\s*:/i.test(trimmedLead) ||
    /confirm(á|a)?\s+tu\s+reserva/i.test(trimmedLead) ||
    /reserva está lista/i.test(trimmedLead);
  const lead =
    trimmedLead && !leadRestatesSummary ? `${trimmedLead}\n\n` : '🤖\n\n';

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

/** FAQ de platos adeudada: híbrido inline con la consulta original (no el “Somos N”). */
async function fulfillOwedReservationDishFaq(params: {
  conversationId: string;
  partySize: number;
  pending: PendingReservationDishFaq;
  enrichedBase: EnrichedContext;
  detectionContext: DetectionContext | null | undefined;
  hasEnvironments: boolean;
  fallbackText: string;
}): Promise<{ handlerResult: HandlerResult; dataCollectionDelegated: true }> {
  const reason = dishFaqDelegationReasonForPartySize(params.partySize);
  const userText = dishFaqUserMessageForHybrid(params.pending);
  await clearPendingReservationDishFaq(params.conversationId);
  await patchConversationMetadata(params.conversationId, {
    reservation_faq_delegation: buildReservationFaqDelegation(reason),
  });
  console.log(
    JSON.stringify({
      event: '[reservation-agent] dish_faq_fulfilled_from_pending',
      reason,
      conversationId: params.conversationId,
    })
  );

  const faqCtx = withDishFaqEnrichedContext(params.enrichedBase, {
    userText,
    partySize: params.partySize,
    reason,
  });

  let mainResult: HandlerResult | null = null;
  let discardedReentrySignal = false;
  try {
    const delegated = await delegateToMainWithDetection({
      enrichedCtx: faqCtx,
      userMessage: userText,
      detectionContext: params.detectionContext,
    });
    mainResult = delegated.handlerResult;
    discardedReentrySignal = delegated.discardedReentrySignal;
  } catch (err) {
    console.error('[reservation-agent] error en dish_faq_pending:', err);
  } finally {
    await omitConversationMetadataKeys(params.conversationId, [
      RESERVATION_FAQ_DELEGATION_KEY,
    ]);
  }

  if (discardedReentrySignal) {
    return {
      handlerResult: {
        content: buildDiscardedReentryMessage('reservation'),
        isInteractive: false,
      },
      dataCollectionDelegated: true,
    };
  }

  const baseResult = mainResult ?? {
    content: params.fallbackText,
    isInteractive: false,
  };
  const freshState = await findOrCreateConversationState(params.conversationId);
  const freshMeta = normalizeMetadata(freshState.metadata);
  const resume = buildResumeFollowUp({
    kind: 'reservation',
    draft: freshMeta.reservation_draft,
    hasEnvironments: params.hasEnvironments,
    includeContinueOrCancel: true,
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

  // Comando de dominio (texto o CANCEL_ORDER): el wipe es el del comando,
  // aunque este nodo tenga el turno.
  const domainCancel = resolveDomainCancelCommand({
    payloadId,
    userMessage: ctx.message?.text?.body,
  });
  if (domainCancel === 'reservation') {
    const handlerResult = await executeReservationCancellation(conversationId);
    return { handlerResult, dataCollectionDelegated: true };
  }
  if (domainCancel === 'order') {
    const result = await buildCancelOrderMessage(
      conversation,
      business.id,
      customer.phone_number ?? ctx.to ?? ''
    );
    if (result) {
      return {
        handlerResult:
          typeof result === 'string'
            ? { content: result, isInteractive: false, skipBodyHumanization: true }
            : { content: result, isInteractive: true, skipBodyHumanization: true },
        dataCollectionDelegated: true,
      };
    }
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
    const { clearWelcomeEligible } = await import(
      '../../../services/welcomeEligible.service'
    );
    await clearWelcomeEligible(conversationId).catch(() => undefined);
    // Personas del *pedido* no sobreviven a la apertura de la mesa: el híbrido
    // puede haber llamado save_party_size en el mismo turno en que delegó, y
    // ese Fact reaparecería como "Personas para el pedido" tras el handback.
    // Este camino llega con carrito vacío (con carrito se pide confirmar antes).
    const { omitConversationMetadataKeys } = await import(
      '../../../repositories/conversationState.repository'
    );
    try {
      await omitConversationMetadataKeys(conversationId, [
        'requestedPartySize',
        'peopleCount',
      ]);
    } catch {
      /* no bloquea la apertura de la sesión */
    }
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
    availableSlots: [],
    maxPartySize: null,
  };

  // Catálogo de slots del día (tipable select_slot + ledger del ReAct).
  const draftForCatalog = await readReservationDraft(conversationId);
  if (draftForCatalog.date) {
    try {
      const slotsForDate = await fetchReservationSlotsForBusinessDate(
        business.id,
        normalizeDate(draftForCatalog.date)
      );
      reservationCtx.availableSlots = slotsForDate.map((s) => ({
        id: s.id,
        startTime: s.start_time,
        endTime: s.end_time,
      }));
    } catch (err) {
      console.error('[reservation-agent] error cargando slots para tipable:', err);
    }
  }

  try {
    reservationCtx.maxPartySize = await getMaxCombinablePartySize(business.id);
  } catch (err) {
    console.error('[reservation-agent] error cargando capacidad para tipable:', err);
  }

  // ── Tipables fulfilled en el nodo (§3.11) — ANTES del ReAct ───────────────
  // Mismo borde que el botón: extractPendingTurnResponse → efecto, sin esperar
  // a que el modelo llame resolve_* / save_reservation_*.
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

    if (tipableStep === 'slot' && (reservationCtx.availableSlots?.length ?? 0) > 0) {
      const slotCatalog = reservationCtx.availableSlots ?? [];
      const extraction = await extractSelectSlotPending(tipableText, slotCatalog);
      console.log(
        JSON.stringify({
          event: '[reservation-agent] select_slot_tipable_extraction',
          status: extraction.status,
          confidence: extraction.confidence,
          source: extraction.source,
          conversationId,
        })
      );
      if (
        extraction.status === 'fulfilled' &&
        extraction.value &&
        isValidSlotSelection(extraction.value.slotId, slotCatalog)
      ) {
        const chosen = slotCatalog.find((s) => s.id === extraction.value!.slotId);
        if (chosen) {
          const freshDraft = await patchReservationDraft(conversationId, {
            slotId: chosen.id,
            time: chosen.startTime,
            endTime: chosen.endTime,
          });
          const nextAfterSlot = nextReservationStep(
            {
              date: freshDraft.date,
              slotId: freshDraft.slotId,
              partySize: freshDraft.partySize,
              environmentId: freshDraft.environmentId,
            },
            { hasEnvironments: environments.length > 0 }
          );
          // Draft ya completo → misma tarjeta que el tipable de ambiente.
          if (
            nextAfterSlot === 'confirm' &&
            freshDraft.date &&
            freshDraft.time &&
            freshDraft.endTime &&
            freshDraft.partySize != null
          ) {
            const environmentName = await resolveEnvironmentName(
              freshDraft.environmentId,
              business.id
            );
            const ack = formatBotUserMessage(
              'Horario',
              '⏰',
              `Listo, anoté *${chosen.startTime}*.`
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
          // Falta personas/ambiente: seguir al ReAct sin re-extraer el tipable.
          reservationCtx.skipPendingExtraction = true;
        }
      }
    } else if (tipableStep === 'party_size') {
      const max = reservationCtx.maxPartySize ?? 0;
      const extraction = await extractPartySizePending(
        tipableText,
        max > 0 ? max : null
      );
      console.log(
        JSON.stringify({
          event: '[reservation-agent] party_size_tipable_extraction',
          status: extraction.status,
          confidence: extraction.confidence,
          source: extraction.source,
          conversationId,
        })
      );
      if (extraction.status === 'fulfilled' && extraction.value) {
        const count = extraction.value.count;
        if (max > 0 && count > max) {
          return {
            handlerResult: {
              content: formatBotUserMessage(
                'Cantidad de Personas',
                '👥',
                `Para esta reserva el máximo es *${max}* personas. ¿Cuántos van a ser?`
              ),
              isInteractive: false,
              skipBodyHumanization: true,
            },
            dataCollectionDelegated: true,
          };
        }
        if (isValidPartySizeSelection(count, max)) {
          const freshDraft = await patchReservationDraft(conversationId, {
            partySize: count,
          });
          const owedDishFaq = await readPendingReservationDishFaq(conversationId);
          if (
            shouldFulfillReservationDishFaq({
              pending: owedDishFaq,
              partySize: freshDraft.partySize,
            }) &&
            owedDishFaq
          ) {
            return fulfillOwedReservationDishFaq({
              conversationId,
              partySize: freshDraft.partySize as number,
              pending: owedDishFaq,
              enrichedBase,
              detectionContext: state.detectionContext,
              hasEnvironments: environments.length > 0,
              fallbackText: ASK_RESERVATION_PARTY_SIZE_FOR_DISHES,
            });
          }
          const nextAfterParty = nextReservationStep(
            {
              date: freshDraft.date,
              slotId: freshDraft.slotId,
              partySize: freshDraft.partySize,
              environmentId: freshDraft.environmentId,
            },
            { hasEnvironments: environments.length > 0 }
          );
          if (
            nextAfterParty === 'confirm' &&
            freshDraft.date &&
            freshDraft.time &&
            freshDraft.endTime &&
            freshDraft.partySize != null
          ) {
            const environmentName = await resolveEnvironmentName(
              freshDraft.environmentId,
              business.id
            );
            const ack = formatBotUserMessage(
              'Cantidad de Personas',
              '👥',
              `Listo, anoté *${count}* personas.`
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
          reservationCtx.skipPendingExtraction = true;
        }
      }
    } else if (tipableStep === 'environment' && environments.length > 0) {
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
        const freshDraft = await patchReservationDraft(conversationId, {
          environmentId: extraction.value.environmentId,
        });
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

  const owedBeforeReact = await readPendingReservationDishFaq(conversationId);
  const draftBeforeReact = await readReservationDraft(conversationId);
  if (
    shouldFulfillReservationDishFaq({
      pending: owedBeforeReact,
      partySize: draftBeforeReact.partySize,
    }) &&
    owedBeforeReact &&
    draftBeforeReact.partySize != null
  ) {
    return fulfillOwedReservationDishFaq({
      conversationId,
      partySize: draftBeforeReact.partySize,
      pending: owedBeforeReact,
      enrichedBase,
      detectionContext: state.detectionContext,
      hasEnvironments: environments.length > 0,
      fallbackText: ASK_RESERVATION_PARTY_SIZE_FOR_DISHES,
    });
  }

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
    const draftForFaq = await readReservationDraft(conversationId);
    if (
      shouldBlockDishFaqWithoutPartySize({
        delegateToMain: true,
        reason: signals.delegateToMainReason,
        partySize: draftForFaq.partySize,
      })
    ) {
      console.log(
        JSON.stringify({
          event: '[reservation-agent] dish_faq_blocked_missing_party_size',
          reason: signals.delegateToMainReason,
          conversationId,
        })
      );
      await patchConversationMetadata(conversationId, {
        [PENDING_RESERVATION_DISH_FAQ_KEY]: buildPendingReservationDishFaq({
          reason: signals.delegateToMainReason,
          originalUserMessage: ctx.message?.text?.body,
        }),
      });
      return {
        handlerResult:
          textResponse(ASK_RESERVATION_PARTY_SIZE_FOR_DISHES) ?? {
            content: ASK_RESERVATION_PARTY_SIZE_FOR_DISHES,
            isInteractive: false,
          },
        dataCollectionDelegated: true,
      };
    }

    await clearPendingReservationDishFaq(conversationId);

    console.log(
      JSON.stringify({
        event: '[reservation-agent] delegate_to_main',
        reason: signals.delegateToMainReason,
        conversationId,
      })
    );
    // Fact efímero FAQ: el híbrido ve modo FAQ en [ESTADO DEL CLIENTE] y no
    // empuja Goals de pedido (PLAN-ACCION-RESERVA-FAQ-HIBRIDO D1).
    await patchConversationMetadata(conversationId, {
      reservation_faq_delegation: buildReservationFaqDelegation(
        signals.delegateToMainReason
      ),
    });

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
    } finally {
      await omitConversationMetadataKeys(conversationId, [
        RESERVATION_FAQ_DELEGATION_KEY,
      ]);
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
      includeContinueOrCancel: true,
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

  const owedAfterReact = await readPendingReservationDishFaq(conversationId);
  const draftAfterReact = await readReservationDraft(conversationId);
  if (
    shouldFulfillReservationDishFaq({
      pending: owedAfterReact,
      partySize: draftAfterReact.partySize,
    }) &&
    owedAfterReact &&
    draftAfterReact.partySize != null
  ) {
    return fulfillOwedReservationDishFaq({
      conversationId,
      partySize: draftAfterReact.partySize,
      pending: owedAfterReact,
      enrichedBase,
      detectionContext: state.detectionContext,
      hasEnvironments: environments.length > 0,
      fallbackText: text,
    });
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
