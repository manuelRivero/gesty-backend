import { prisma } from '../lib/prisma';
import { EnrichedContext } from '../controllers/webhook/types';
import { buildListMessageFromButtons } from '../whatsappBuilders';
import type { WhatsAppInteractiveMessage, WhatsAppListMessage } from '../domain/intent/whatsappTemplates';
import { buildSmallTalkButtons } from './smallTalk.service';

const dayNames = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado'
];

const weekdayToIndex: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6
};

const timeToMinutes = (value: string): number => {
  const [hh, mm] = value.split(':').map((part) => Number(part));
  return (hh || 0) * 60 + (mm || 0);
};

const isWithinRange = (current: number, start: number, end: number): boolean => {
  if (start === end) return false;
  if (end > start) {
    return current >= start && current < end;
  }
  // Overnight shift (e.g., 19:00 - 02:00)
  return current >= start || current < end;
};

const getLocalParts = (timezone: string, date = new Date()) => {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  });
  const parts = formatter.formatToParts(date);
  const weekday = parts.find((p) => p.type === 'weekday')?.value.toLowerCase() ?? 'sunday';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return { weekdayIndex: weekdayToIndex[weekday] ?? 0, minutes: hour * 60 + minute };
};

export const getBusinessOpenInfo = async (params: {
  businessId: string;
  timezone: string;
}): Promise<{ isOpen: boolean; nextOpenText: string | null }> => {
  const hours = await prisma.business_hours.findMany({
    where: { business_id: params.businessId },
    orderBy: { day_of_week: 'asc' }
  });

  if (!hours.length) {
    return { isOpen: false, nextOpenText: null };
  }

  const byDay = new Map<number, { closed: boolean; slots: Array<{ open: number; close: number }> }>();
  for (const hour of hours) {
    const existing = byDay.get(hour.day_of_week) ?? { closed: false, slots: [] };
    if (hour.is_closed) {
      existing.closed = true;
    } else {
      existing.slots.push({
        open: timeToMinutes(hour.opens_at),
        close: timeToMinutes(hour.closes_at)
      });
    }
    byDay.set(hour.day_of_week, existing);
  }

  const { weekdayIndex, minutes } = getLocalParts(params.timezone);
  const today = byDay.get(weekdayIndex);
  if (today && !today.closed) {
    for (const slot of today.slots) {
      if (isWithinRange(minutes, slot.open, slot.close)) {
        return { isOpen: true, nextOpenText: null };
      }
    }
  }

  for (let offset = 0; offset < 7; offset += 1) {
    const dayIndex = (weekdayIndex + offset) % 7;
    const entry = byDay.get(dayIndex);
    if (!entry || entry.closed || entry.slots.length === 0) {
      continue;
    }

    const sortedSlots = [...entry.slots].sort((a, b) => a.open - b.open);
    if (offset === 0) {
      const upcoming = sortedSlots.find((slot) => minutes < slot.open);
      if (upcoming) {
        return {
          isOpen: false,
          nextOpenText: `${dayNames[dayIndex]} a las ${Math.floor(upcoming.open / 60)
            .toString()
            .padStart(2, '0')}:${(upcoming.open % 60).toString().padStart(2, '0')} hs`
        };
      }
      continue;
    }

    const first = sortedSlots[0];
    return {
      isOpen: false,
      nextOpenText: `${dayNames[dayIndex]} a las ${Math.floor(first.open / 60)
        .toString()
        .padStart(2, '0')}:${(first.open % 60).toString().padStart(2, '0')} hs`
    };
  }

  return { isOpen: false, nextOpenText: null };
};

export const buildBusinessHoursMessage = async (
  ctx: EnrichedContext
): Promise<WhatsAppListMessage | string | null> => {
  const businessId = ctx.business?.id;
  if (!businessId) return null;

  const hours = await prisma.business_hours.findMany({
    where: { business_id: businessId },
    orderBy: { day_of_week: 'asc' }
  });

  if (!hours.length) {
    return 'Por el momento no tengo horarios disponibles.';
  }

  const byDay = new Map<number, { closed: boolean; slots: string[] }>();
  for (const hour of hours) {
    const existing = byDay.get(hour.day_of_week) ?? {
      closed: false,
      slots: []
    };
    if (hour.is_closed) {
      existing.closed = true;
    } else {
      existing.slots.push(`${hour.opens_at} hs a ${hour.closes_at} hs`);
    }
    byDay.set(hour.day_of_week, existing);
  }

  const lines: string[] = [];
  for (const [dayIndex, dayLabel] of dayNames.entries()) {
    const entry = byDay.get(dayIndex);
    if (!entry) continue;
    if (entry.closed || entry.slots.length === 0) {
      lines.push(`${dayLabel}: Cerrado`);
    } else {
      lines.push(`${dayLabel}: ${entry.slots.join(' / ')}`);
    }
  }

  const bodyText = `🤖\n\n*Horarios de atención* 🕐\n\n${lines.join('\n')}\n\n¿Qué te gustaría hacer ahora?`;
  const buttons = await buildSmallTalkButtons(ctx);

  return buildListMessageFromButtons(
    bodyText,
    buttons,
    'Ver opciones',
    '',
    'Seleccioná una opción para continuar'
  );
};

/**
 * Texto del aviso “estamos cerrados” para el cliente.
 * `nextOpenText` debe venir del mismo resultado de {@link getBusinessOpenInfo} que ya usaste
 * para decidir `isOpen` (así no se vuelve a consultar horarios).
 */
export const formatClosedBusinessCustomerNotice = (
  nextOpenText: string | null
): string => {
  const nextOpenLine = nextOpenText
    ? `Nuestro próximo horario de apertura es ${nextOpenText}.`
    : '';

  return `🤖\n\n*En este momento estamos cerrados.* ❌\n\n${nextOpenLine}\n\nPor favor escribinos en el horario de atención.`;
};

export const CONFIRM_CLOSED_ORDER = 'CONFIRM_CLOSED_ORDER';
export const CANCEL_CLOSED_ORDER = 'CANCEL_CLOSED_ORDER';

export const buildClosedOrderConfirmationMessage = (
  nextOpenText: string | null
): WhatsAppInteractiveMessage => {
  const nextOpenLine = nextOpenText
    ? `Tu pedido será atendido en el próximo turno: *${nextOpenText}*.`
    : 'Tu pedido será atendido cuando abramos nuevamente.';

  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '¿Confirmar pedido?' },
      body: {
        text: `🤖\n\n*En este momento estamos cerrados.* ❌\n\n${nextOpenLine}\n\n¿Querés que registremos tu pedido de todas formas?`
      },
      footer: { text: 'Será procesado cuando abramos' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: CONFIRM_CLOSED_ORDER, title: 'Sí, confirmar' } },
          { type: 'reply', reply: { id: CANCEL_CLOSED_ORDER, title: 'No, cancelar' } }
        ]
      }
    }
  };
};
