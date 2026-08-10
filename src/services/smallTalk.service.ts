import { prisma } from '../lib/prisma';
import { EnrichedContext } from '../controllers/webhook/types';
import { buildListMessageFromButtons } from '../whatsappBuilders';
import type { WhatsAppListMessage } from '../domain/intent/whatsappTemplates';
import { formatBotUserMessage } from './productQuery/utils';
import { getBusinessConfig } from './businessConfig.service';
import { isReservationAgentEnabled } from '../config/env';
import {
  buildShortcutsThenListBody,
  shortcutBullet,
} from '../whatsappBuilders/listShortcutsBody';

const baseButtons = [
  {
    title: 'Ver menú',
    payload: 'VIEW_MENU',
    description: 'Explorar platos disponibles',
    sectionTitle: 'Opciones'
  },
  {
    title: 'Horarios de atención',
    payload: 'BUSINESS_HOURS',
    description: 'Ver los horarios de atención',
    sectionTitle: 'Opciones'
  },
  {
    title: 'Hacer una consulta',
    payload: 'ASK_QUESTION',
    description: 'Hacer una consulta',
    sectionTitle: 'Opciones'
  }
];

/** Atajo tipable en negrita alineado al payload / título de la fila WA. */
export function welcomeShortcutBullet(button: {
  title: string;
  payload: string;
}): string {
  switch (button.payload) {
    case 'VIEW_MENU':
      return shortcutBullet('Menú');
    case 'BUSINESS_HOURS':
      return shortcutBullet('Horarios');
    case 'ASK_QUESTION':
      return shortcutBullet('Consulta');
    case 'VIEW_CART':
    case 'VIEW_ORDER':
      return '• Ver *pedido*';
    case 'VIEW_RESERVATION':
      return shortcutBullet('Reservar', 'mesa');
    case 'EDIT_ADDRESS':
      return shortcutBullet('Editar', 'dirección');
    default: {
      const parts = button.title.trim().split(/\s+/).filter(Boolean);
      if (parts.length === 0) return '';
      const [first, ...rest] = parts;
      return rest.length > 0
        ? shortcutBullet(first!, rest.join(' '))
        : shortcutBullet(first!);
    }
  }
}

export function buildWelcomeShortcutBullets(
  buttons: Array<{ title: string; payload: string }>
): string[] {
  return buttons.map(welcomeShortcutBullet).filter(Boolean);
}

export const buildSmallTalkButtons = async (ctx: EnrichedContext) => {
  const business = await prisma.business.findFirst({
    where: { name: ctx.business?.name ?? '' }
  });
  const businessId = ctx.business?.id ?? business?.id ?? null;

  const [activeOrder, defaultAddress, businessConfig] = await Promise.all([
    prisma.draft_order.findFirst({
      where: {
        business_id: businessId,
        customer_phone: ctx.customer?.phone_number,
        status: 'active'
      },
      select: { id: true }
    }),
    prisma.customer_address.findFirst({
      where: {
        customer_id: ctx.customer?.id,
        is_default: true
      },
      select: { id: true }
    }),
    businessId ? getBusinessConfig(businessId) : Promise.resolve(null)
  ]);

  const buttons = [...baseButtons];
  if (activeOrder) {
    buttons.unshift({
      title: 'Ver pedido',
      payload: 'VIEW_CART',
      description: 'Revisar tu pedido actual',
      sectionTitle: 'Opciones'
    });
  }
  if (isReservationAgentEnabled() && businessConfig?.reservations_enabled) {
    buttons.push({
      title: 'Reservar mesa',
      payload: 'VIEW_RESERVATION',
      description: 'Reservar una mesa',
      sectionTitle: 'Opciones'
    });
  }
  if (defaultAddress) {
    buttons.push({
      title: 'Editar dirección',
      payload: 'EDIT_ADDRESS',
      description: 'Actualizar dirección de entrega',
      sectionTitle: 'Opciones'
    });
  }

  return buttons;
};

export const buildSmallTalkMenu = async (
    ctx: EnrichedContext,
    /** Texto propio del agente (ej. saludo del híbrido) a usar como body en vez del genérico. */
    customBodyText?: string
): Promise<WhatsAppListMessage | string | null> => {
  const businessNameFromCtx = ctx.business?.name;
  if (!businessNameFromCtx) {
    return formatBotUserMessage(
      'Asistente',
      '👋',
      customBodyText?.trim() || '¿En qué te puedo ayudar?'
    );
  }

  const business = await prisma.business.findFirst({
    where: { name: businessNameFromCtx }
  });

  const businessName = business?.name ?? businessNameFromCtx;
  const buttons = await buildSmallTalkButtons(ctx);

  const intro =
    customBodyText?.trim() ||
    `¡Hola! Soy el asistente de *${businessName}*.\n\n¿En qué te puedo ayudar?`;

  const bodyText = formatBotUserMessage(
    `Bienvenido a ${businessName}`,
    '👋',
    buildShortcutsThenListBody(intro, buildWelcomeShortcutBullets(buttons))
  );

  return buildListMessageFromButtons(
    bodyText,
    buttons,
    'Ver opciones',
    '',
    'Elegí o escribí'
  );
};
