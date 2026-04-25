import type { EnrichedContext, HandlerResult } from '../../controllers/webhook/types';
import type { WhatsAppInteractiveMessage, WhatsAppListMessage } from '../../domain/intent/whatsappTemplates';
import { closeConversationAfterReservation } from '../../repositories/conversation.repository';
import {
  createReservationWithTables,
  fetchActiveReservationSlotById,
  findActiveEnvironmentsByBusinessId,
  findActiveTablesByBusinessAndEnvironment,
  findAnyFutureOccupyingReservationForCustomer,
  findEnvironmentNameById,
  findFutureOccupyingReservationForCustomerOrdered,
  findLatestOccupyingReservationForCustomer,
  findLatestOccupyingReservationWithTablesForCustomer,
  findOverlappingReservationForTable,
  findReservationBlockAtStart,
  findReservationByIdForCustomer,
  updateReservationStatus,
} from '../../repositories/reservation.repository';
import { updateConversationState } from '../../repositories/conversationState.repository';
import { buildListMessageFromButtons } from '../../whatsappBuilders';
import { emitAdminReservationEditStarted } from '../../socket/adminSocket';
import { generateReservationQR } from '../../utils/reservationQr';
import type { FindTableInput, FindTableResult, ReservationState } from './types';
import { wantsReservationManagement } from './reservationIntentText';
import {
  buildDateTime,
  filterSlotsByTurnLead,
  formatDbTimeReservation,
  formatDisplayTime,
  formatReservationDateDb,
  getNextDateExample,
  getReservationSlotsForBusinessDate,
  mapEnvironmentToId,
  normalizeDate,
  selectTables,
} from './utils';
import { getBusinessConfig } from '../businessConfig.service';

function filterSlotsByLeadMinutes(
  slots: Array<{ id: string; start_time: string; end_time: string }>,
  date: Date,
  now: Date,
  minLeadMinutes: number
): Array<{ id: string; start_time: string; end_time: string }> {
  if (minLeadMinutes <= 0) {
    return slots;
  }
  const threshold = new Date(now.getTime() + minLeadMinutes * 60000);
  return slots.filter((slot) => {
    const slotStart = buildDateTime(date, slot.start_time);
    return slotStart.getTime() >= threshold.getTime();
  });
}

/** Instrucción breve; el formato se valida con `dateRegex` / `normalizeDate`. */
function reservationAskDateInstructions(nextDateExample: string): string {
  return (
    `*¿Para qué fecha querés reservar?*\n\n` +
    `Ejemplo: *${nextDateExample}* (*DD/MM* o *DD/MM/AAAA*).`
  );
}

function reservationAskPartyInstructions(): string {
  return `*¿Para cuántas personas?*\n\nEjemplo: *4*`;
}

/** Misma UI que cuando hay reserva activa y el usuario entra a "reservar" de nuevo. */
export function buildActiveReservationManagementMessage(): WhatsAppInteractiveMessage {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '' },
      body: {
        text: '🤖\n\n📋 *Reserva activa* ⚠️\n\nYa tenés una reserva activa.\n\nPodés gestionarla desde estas opciones:'
      },
      footer: { text: 'Elegí una opción' },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: 'VIEW_RESERVATION', title: 'Ver mi reserva' }
          },
          {
            type: 'reply',
            reply: { id: 'RESERVATION_RESET', title: 'Editar reserva' }
          },
          {
            type: 'reply',
            reply: { id: 'RESERVATION_CANCEL', title: 'Cancelar reserva' }
          }
        ]
      }
    }
  };
}

function buildReservationErrorMessage(text: string): WhatsAppInteractiveMessage {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '' },
      body: { text: text.startsWith('🤖') ? text : `🤖\n\n${text}` },
      footer: { text: 'Elegí una opción' },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: 'RESERVATION_CANCEL', title: 'Cancelar reserva' }
          },
          {
            type: 'reply',
            reply: { id: 'RESERVATION_RESET', title: 'Reiniciar reserva' }
          }
        ]
      }
    }
  };
}

async function findAvailableTable(
  input: FindTableInput
): Promise<FindTableResult> {
  const { businessId, date, startTime, endTime, partySize, environmentId } =
    input;
  console.log('[Reservation] Input:', {
    businessId,
    date,
    startTime,
    endTime,
    partySize,
    environmentId
  });

  const reservationDate = normalizeDate(date);
  const startDateTime = buildDateTime(reservationDate, startTime);
  const endDateTime = buildDateTime(reservationDate, endTime);
  console.log('[Reservation] Time range:', {
    startTime: startDateTime,
    endTime: endDateTime
  });

  const tables = await findActiveTablesByBusinessAndEnvironment(
    businessId,
    environmentId
  );
  console.log('[Reservation] Tables found:', tables.length);

  if (!tables.length) {
    console.log('[Reservation] No tables match basic filters');
    return { tableIds: null, reason: 'NO_TABLES' };
  }

  const availableTables: typeof tables = [];
  for (const table of tables) {
    console.log('[Reservation] Checking table:', {
      tableId: table.id,
      capacity: table.capacity,
      environmentId: table.environment_id
    });
    const overlappingReservation = await findOverlappingReservationForTable(
      table.id,
      reservationDate,
      startDateTime
    );

    if (overlappingReservation) {
      console.log('[Reservation] Table blocked by reservation:', {
        tableId: table.id,
        reservationId: overlappingReservation.reservation_id,
        start: overlappingReservation.reservation.start_time,
        end: overlappingReservation.reservation.end_time
      });
      continue;
    }

    const overlappingBlock = await findReservationBlockAtStart(
      table.id,
      table.environment_id,
      reservationDate,
      startDateTime
    );

    if (overlappingBlock) {
      console.log('[Reservation] Table blocked by block:', {
        tableId: table.id,
        blockId: overlappingBlock.id
      });
      continue;
    }

    console.log('[Reservation] Table available:', {
      tableId: table.id
    });
    availableTables.push(table);
  }

  const selectedTables = selectTables(availableTables, partySize);
  if (selectedTables) {
    console.log('[Reservation] Table available:', {
      tableIds: selectedTables.map((table) => table.id)
    });
    return { tableIds: selectedTables.map((table) => table.id) };
  }

  console.log('[Reservation] No available tables found');
  return { tableIds: null, reason: 'NO_AVAILABILITY' };
}

export async function handleViewReservationIntent(
  ctx: EnrichedContext
): Promise<HandlerResult> {
  if (!ctx.customer?.id) {
    return {
      content: '🤖\n\nNo encontramos tu usuario.',
      isInteractive: false
    };
  }

  const r = await findLatestOccupyingReservationWithTablesForCustomer(
    ctx.customer.id
  );

  if (!r) {
    return {
      content: '🤖\n\nNo tenés reservas activas.',
      isInteractive: false
    };
  }

  const messageText = ctx.message?.text?.body?.trim() ?? '';
  if (wantsReservationManagement(messageText)) {
    return {
      content: buildActiveReservationManagementMessage(),
      isInteractive: true
    };
  }

  const dateStr = formatReservationDateDb(r.reservation_date);
  const timeStr = formatDbTimeReservation(r.start_time);
  const mesas = r.reservation_table.map((rt) => `- ${rt.table.name}`).join('\n');
  const summaryText = `🤖\n\n*Tu reserva* 📋\n\n📅 ${dateStr}\n⏰ ${timeStr}\n👥 ${r.party_size}\n\nMesas:\n${mesas}`;
  const qrDataUrl = await generateReservationQR(
    (r as unknown as { checkin_token: string }).checkin_token
  );

  return {
    content: summaryText,
    isInteractive: false,
    followUps: [
      { type: 'image', dataUrl: qrDataUrl },
      {
        type: 'text',
        message: '🤖\n\n¡Gracias por reservar con nosotros! Te esperamos 🙌'
      }
    ]
  };
}

export async function handleViewQrIntent(
  ctx: EnrichedContext
): Promise<HandlerResult> {
  if (!ctx.customer?.id) {
    return {
      content: '🤖\n\nNo encontramos tu usuario.',
      isInteractive: false
    };
  }

  const metadata = ctx.conversationState?.metadata ?? {};
  const lastId = metadata.lastReservationId as string | undefined;

  let r =
    lastId != null
      ? await findReservationByIdForCustomer(lastId, ctx.customer.id)
      : null;

  if (!r) {
    r = await findLatestOccupyingReservationForCustomer(ctx.customer.id);
  }

  if (!r) {
    return {
      content:
        '🤖\n\nNo encontré una reserva para mostrar el código.',
      isInteractive: false
    };
  }

  const qrDataUrl = await generateReservationQR(
    (r as unknown as { checkin_token: string }).checkin_token
  );

  return {
    content: '🤖\n\nAcá está tu código QR para el ingreso.',
    isInteractive: false,
    followUps: [{ type: 'image', dataUrl: qrDataUrl }]
  };
}

export const handleReservationIntent = async (
  ctx: EnrichedContext
): Promise<
  string | WhatsAppInteractiveMessage | WhatsAppListMessage | HandlerResult | null
> => {
  const businessConfig = ctx.business?.id
    ? await getBusinessConfig(ctx.business.id)
    : null;

  if (businessConfig && !businessConfig.reservations_enabled) {
    return '🤖\n\nLas reservas están deshabilitadas temporalmente para este negocio.';
  }

  const reservationMinLeadMinutes =
    businessConfig?.reservation_min_lead_minutes ?? 60;

  const metadata = ctx.conversationState?.metadata ?? {};
  const reservation: ReservationState | undefined = metadata.reservation;
  const messageText = ctx.message?.text?.body?.trim() ?? '';
  const dateRegex = /^\d{1,2}\/\d{1,2}(\/\d{4})?$/;
  const nextDateExample = ctx.business?.id
    ? await getNextDateExample(ctx.business.id)
    : '05/04';

  if (ctx.payloadId === 'RESERVATION_CANCEL') {
    if (!reservation && ctx.customer?.id) {
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const activeReservation =
        await findFutureOccupyingReservationForCustomerOrdered(
          ctx.customer.id,
          now
        );
      if (activeReservation) {
        await updateReservationStatus(activeReservation.id, 'closed');
        return '🤖\n\n*Reserva cancelada* ✅\n\nTu reserva fue cancelada. Si querés, te ayudo a crear una nueva.';
      }
    }
    await updateConversationState(ctx.conversationId, {
      metadata: { ...metadata, reservation: undefined }
    });
    return '🤖\n\n*Reserva cancelada* 🛑\n\nReserva cancelada. ¿Querés que te ayude en algo más?';
  }

  if (ctx.payloadId === 'RESERVATION_RESET') {
    if (ctx.customer?.id && ctx.business?.id) {
      const previousActive = await findLatestOccupyingReservationForCustomer(
        ctx.customer.id
      );
      if (previousActive) {
        emitAdminReservationEditStarted(ctx.business.id, {
          reservationId: previousActive.id
        });
      }
    }
    const nextState: ReservationState = { step: 'ASK_DATE' };
    await updateConversationState(ctx.conversationId, {
      metadata: { ...metadata, reservation: nextState }
    });
    return `🤖\n\n*Reserva reiniciada* 🔄\n\n${reservationAskDateInstructions(nextDateExample)}\n\nRecordá que tomamos reservas con anticipación mínima de un turno.`;
  }

  if (!reservation) {
    if (ctx.customer?.id) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const activeReservation = await findAnyFutureOccupyingReservationForCustomer(
        ctx.customer.id,
        today
      );
      if (activeReservation) {
        return buildActiveReservationManagementMessage();
      }
    }
    const nextState: ReservationState = { step: 'ASK_DATE' };
    await updateConversationState(ctx.conversationId, {
      metadata: { ...metadata, reservation: nextState }
    });
    return `🤖\n\n*Coordinemos tu reserva* 📅\n\n${reservationAskDateInstructions(nextDateExample)}\n\nTe pedimos reservar con anticipación mínima de un turno para poder prepararte una mejor experiencia.`;
  }

  switch (reservation.step) {
    case 'ASK_DATE': {
      if (!messageText) {
        return `🤖\n\n*Fecha de reserva* 📅\n\n${reservationAskDateInstructions(nextDateExample)}\n\nRecordá que las reservas deben hacerse con anticipación mínima de un turno.`;
      }
      if (!dateRegex.test(messageText)) {
        return buildReservationErrorMessage(
          `🤖\n\n*Formato inválido* ❌\n\nUsá *DD/MM* o *DD/MM/AAAA* (ej: *${nextDateExample}*).`
        );
      }
      try {
        const parsedDate = normalizeDate(messageText);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const selected = new Date(parsedDate);
        selected.setHours(0, 0, 0, 0);
        if (selected.getTime() < today.getTime()) {
          return buildReservationErrorMessage(
            `🤖\n\n*Fecha inválida* ❌\n\nEsa fecha ya pasó. Elegí una fecha a futuro (ej: *${nextDateExample}*), con el anticipo mínimo de un turno.`
          );
        }
      } catch (error) {
        if ((error as Error).message === 'INVALID_DATE') {
          return buildReservationErrorMessage(
            `🤖\n\n*Fecha inválida* ❌\n\nEsa fecha no existe en el calendario. Probá otra (ej: *${nextDateExample}*).`
          );
        }
        throw error;
      }
      const nextState: ReservationState = {
        ...reservation,
        date: messageText,
        step: 'ASK_SLOT'
      };
      await updateConversationState(ctx.conversationId, {
        metadata: { ...metadata, reservation: nextState }
      });
      if (!ctx.business?.id) {
        return buildReservationErrorMessage(
          '🤖\n\n*Sin disponibilidad* ❌\n\nNo hay disponibilidad.'
        );
      }
      const date = normalizeDate(messageText);
      const now = new Date();
      const slots = await getReservationSlotsForBusinessDate(
        ctx.business.id,
        date
      );
      const byTurnLead = filterSlotsByTurnLead(slots, date, now);
      const availableSlots = filterSlotsByLeadMinutes(
        byTurnLead,
        date,
        now,
        reservationMinLeadMinutes
      );
      if (!availableSlots.length) {
        return buildReservationErrorMessage(
          '🤖\n\n*Sin slots disponibles* ❌\n\nNo encontramos horarios disponibles para esa fecha. Probá con otra fecha y te ayudo.'
        );
      }
      return buildListMessageFromButtons(
        '🤖\n\n*¡Fecha registrada!* ✅\n\nPerfecto, ya agendé la fecha.\n\n*Horario disponible* 🕒\n\nElegí un horario:',
        availableSlots.map((slot) => ({
          title: slot.start_time,
          payload: `RESERVATION_SLOT:${slot.id}`,
          description: `${slot.start_time} - ${slot.end_time}`,
          sectionTitle: 'Horarios'
        })),
        'Ver horarios',
        '',
        'Seleccioná una opción para continuar'
      );
    }
    case 'ASK_SLOT': {
      if (!ctx.business?.id || !reservation.date) {
        return buildReservationErrorMessage(
          '🤖\n\n*Sin disponibilidad* ❌\n\nNo hay disponibilidad.'
        );
      }
      if (!ctx.payloadId?.startsWith('RESERVATION_SLOT:')) {
        const date = normalizeDate(reservation.date);
        const now = new Date();
        const slots = await getReservationSlotsForBusinessDate(
          ctx.business.id,
          date
        );
        const byTurnLead = filterSlotsByTurnLead(slots, date, now);
        const availableSlots = filterSlotsByLeadMinutes(
          byTurnLead,
          date,
          now,
          reservationMinLeadMinutes
        );
        if (!availableSlots.length) {
          return buildReservationErrorMessage(
            '🤖\n\n*Sin slots disponibles* ❌\n\nNo encontramos horarios disponibles para esa fecha. Probá con otra fecha y te ayudo.'
          );
        }
        return buildListMessageFromButtons(
          '🤖\n\n*Horario requerido* ⏰\n\nElegí un horario de la lista para continuar.',
          availableSlots.map((slot) => ({
            title: slot.start_time,
            payload: `RESERVATION_SLOT:${slot.id}`,
            description: `${slot.start_time} - ${slot.end_time}`,
            sectionTitle: 'Horarios'
          })),
          'Ver horarios',
          '',
          'Seleccioná una opción para continuar'
        );
      }
      const slotId = ctx.payloadId.split(':')[1];
      const slot = await fetchActiveReservationSlotById(
        slotId,
        ctx.business.id
      );
      if (!slot) {
        return buildReservationErrorMessage(
          '🤖\n\n*Slot inválido* ❌\n\nEse horario ya no está disponible. Elegí otro para continuar.'
        );
      }
      const reservationDateForLead = normalizeDate(reservation.date);
      const slotStart = buildDateTime(reservationDateForLead, slot.start_time);
      const minAllowedStart = new Date(
        Date.now() + reservationMinLeadMinutes * 60000
      );
      if (slotStart.getTime() < minAllowedStart.getTime()) {
        return buildReservationErrorMessage(
          '🤖\n\n*Horario no disponible* ❌\n\nEse horario no cumple el tiempo mínimo de anticipación. Elegí otro horario.'
        );
      }
      const nextState: ReservationState = {
        ...reservation,
        slotId: slot.id,
        time: slot.start_time,
        endTime: slot.end_time,
        step: 'ASK_PARTY_SIZE'
      };
      await updateConversationState(ctx.conversationId, {
        metadata: { ...metadata, reservation: nextState }
      });
      return `🤖\n\n*¡Hora registrada!* ✅\n\nExcelente, ya tengo la hora.\n\n*Cantidad de personas* 👥\n\n${reservationAskPartyInstructions()}`;
    }
    case 'ASK_PARTY_SIZE': {
      const partySize = Number(messageText);
      if (Number.isNaN(partySize) || partySize <= 0) {
        return buildReservationErrorMessage(
          '🤖\n\n*Número inválido* ❌\n\nEnviá un número (ej: *4*, *2*).'
        );
      }
      const nextState: ReservationState = {
        ...reservation,
        partySize,
        step: 'ASK_ENVIRONMENT'
      };
      await updateConversationState(ctx.conversationId, {
        metadata: { ...metadata, reservation: nextState }
      });
      const environments = ctx.business?.id
        ? await findActiveEnvironmentsByBusinessId(ctx.business.id)
        : [];

      if (!environments.length) {
        await updateConversationState(ctx.conversationId, {
          metadata: {
            ...metadata,
            reservation: { ...nextState, environmentId: undefined, step: 'CONFIRM' }
          }
        });
        const summary = [
          `Fecha: ${nextState.date ?? '-'}`,
          `Hora: ${formatDisplayTime(nextState.time)}`,
          `Personas: ${nextState.partySize ?? '-'}`,
          'Ambiente: sin preferencia'
        ].join('\n');
        return {
          type: 'interactive',
          interactive: {
            type: 'button',
            header: { type: 'text', text: '' },
            body: {
              text: `🤖\n\n*¡Cantidad registrada!* ✅\n\nYa tengo la cantidad de personas.\n\n*Confirmar reserva* ✅\n\nRevisá los datos:\n${summary}`
            },
            footer: { text: 'Seleccioná una opción' },
            action: {
              buttons: [
                {
                  type: 'reply',
                  reply: { id: 'RESERVATION_CONFIRM', title: '✅ Confirmar' }
                },
                {
                  type: 'reply',
                  reply: { id: 'RESERVATION_CANCEL', title: '❌ Cancelar' }
                }
              ]
            }
          }
        };
      }

      const buttons = environments.map((env) => ({
        title: env.name,
        payload: `RESERVATION_ENV:${env.id}`,
        description: env.description ?? 'Seleccioná este ambiente',
        sectionTitle: 'Ambientes'
      }));
      buttons.push({
        title: 'Sin preferencia',
        payload: 'RESERVATION_ENV_NONE',
        description: 'Cualquier ambiente',
        sectionTitle: 'Ambientes'
      });

      return buildListMessageFromButtons(
        '🤖\n\n*¡Cantidad registrada!* ✅\n\nYa tengo la cantidad de personas.\n\n*Preferencia de ambiente* 🪑\n\n¿En qué ambiente preferís reservar?',
        buttons,
        'Ver opciones',
        '',
        'Seleccioná una opción para continuar'
      );
    }
    case 'ASK_ENVIRONMENT': {
      const envId =
        ctx.payloadId?.startsWith('RESERVATION_ENV:')
          ? ctx.payloadId.split(':')[1]
          : ctx.payloadId === 'RESERVATION_ENV_NONE'
            ? undefined
            : mapEnvironmentToId(messageText, ctx.business?.environments ?? []);

      const nextState: ReservationState = {
        ...reservation,
        environmentId: envId ?? undefined,
        step: 'CONFIRM'
      };
      await updateConversationState(ctx.conversationId, {
        metadata: { ...metadata, reservation: nextState }
      });

      const environmentName = envId
        ? (await findEnvironmentNameById(envId)) ?? undefined
        : undefined;

      const summary = [
        `Fecha: ${nextState.date ?? '-'}`,
        `Hora: ${formatDisplayTime(nextState.time)}`,
        `Personas: ${nextState.partySize ?? '-'}`,
        `Ambiente: ${environmentName ?? 'sin preferencia'}`
      ].join('\n');

      return {
        type: 'interactive',
        interactive: {
          type: 'button',
          header: { type: 'text', text: '' },
          body: {
            text: `🤖\n\n*Confirmar reserva* ✅\n\nRevisá los datos:\n${summary}`
          },
          footer: { text: 'Seleccioná una opción' },
          action: {
            buttons: [
              {
                type: 'reply',
                reply: { id: 'RESERVATION_CONFIRM', title: '✅ Confirmar' }
              },
              {
                type: 'reply',
                reply: { id: 'RESERVATION_CANCEL', title: '❌ Cancelar' }
              }
            ]
          }
        }
      };
    }
    case 'CONFIRM': {
      if (ctx.payloadId !== 'RESERVATION_CONFIRM') {
        const summary = [
          `Fecha: ${reservation.date ?? '-'}`,
          `Hora: ${formatDisplayTime(reservation.time)}`,
          `Personas: ${reservation.partySize ?? '-'}`,
          `Ambiente: ${reservation.environmentId ?? 'sin preferencia'}`
        ].join('\n');
        return {
          type: 'interactive',
          interactive: {
            type: 'button',
            header: { type: 'text', text: '' },
            body: {
              text: `🤖\n\n*Confirmar reserva* ✅\n\nRevisá los datos:\n${summary}`
            },
            footer: { text: 'Seleccioná una opción' },
            action: {
              buttons: [
                {
                  type: 'reply',
                  reply: { id: 'RESERVATION_CONFIRM', title: '✅ Confirmar' }
                },
                {
                  type: 'reply',
                  reply: { id: 'RESERVATION_CANCEL', title: '❌ Cancelar' }
                }
              ]
            }
          }
        };
      }
      if (!ctx.business?.id) {
        return '🤖\n\n*Sin disponibilidad* ❌\n\nNo hay disponibilidad.';
      }
      console.log(
        `[Reservation] CONFIRM: usuario pulsó Confirmar, buscando mesas businessId=${ctx.business.id} conversationId=${ctx.conversationId}`
      );
      const result = await findAvailableTable({
        businessId: ctx.business.id,
        date: reservation.date ?? '',
        startTime: reservation.time ?? '',
        endTime: reservation.endTime ?? '',
        partySize: reservation.partySize ?? 0,
        environmentId: reservation.environmentId
      });
      if (!result.tableIds?.length) {
        console.warn(
          `[Reservation] CONFIRM: findAvailableTable no devolvió mesas (tableIds vacío). No hay fila en DB ni emit. businessId=${ctx.business.id}`
        );
      }
      if (!ctx.customer?.id) {
        console.warn(
          `[Reservation] CONFIRM: sin customer.id; no se crea reserva. conversationId=${ctx.conversationId}`
        );
      }
      if (result.tableIds && ctx.customer?.id) {
        const reservationDate = normalizeDate(reservation.date ?? '');
        const created = await createReservationWithTables({
          businessId: ctx.business.id,
          customerId: ctx.customer.id,
          conversationId: ctx.conversationId,
          partySize: reservation.partySize ?? 0,
          reservationDate,
          startDateTime: buildDateTime(
            reservationDate,
            reservation.time ?? ''
          ),
          endDateTime: buildDateTime(
            reservationDate,
            reservation.endTime ?? ''
          ),
          tableIds: result.tableIds
        });

        let followUps: HandlerResult['followUps'];
        try {
          const checkinToken = (created as unknown as { checkin_token: string })
            .checkin_token;
          const qrDataUrl = await generateReservationQR(checkinToken);
          followUps = [{ type: 'image', dataUrl: qrDataUrl }];
        } catch (err) {
          console.error('[Reservation] No se pudo generar el QR:', err);
        }

        await updateConversationState(ctx.conversationId, {
          metadata: {
            ...metadata,
            reservation: undefined,
            lastReservationId: created.id
          }
        });
        await closeConversationAfterReservation(ctx.conversationId);

        const bodyText = `🤖\n\n*Reserva confirmada* ✅\n\n📅 ${reservation.date ?? '-'}\n⏰ ${formatDisplayTime(reservation.time)}\n👥 ${reservation.partySize ?? '-'}\n\n📍 *Importante:* para ingresar, cada persona del grupo (o vos si venís solo/a) debe presentar este QR.\n\nReenviáselo ahora a quienes te acompañen para agilizar el ingreso 👇`;

        const confirmResult: HandlerResult = {
          content: bodyText,
          isInteractive: false,
          followUps: [
            ...(followUps ?? []),
            {
              type: 'text',
              message:
                '🤖\n\n¡Gracias por reservar con nosotros! Te esperamos 🙌'
            }
          ]
        };
        return confirmResult;
      }

      await updateConversationState(ctx.conversationId, {
        metadata: { ...metadata, reservation: undefined }
      });
      return '🤖\n\n*Sin disponibilidad* ❌\n\nNo hay disponibilidad para ese horario predefinido.';
    }
    default:
      return null;
  }
};
