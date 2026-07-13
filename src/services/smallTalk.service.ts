import { prisma } from '../lib/prisma';
import { EnrichedContext } from '../controllers/webhook/types';
import { buildListMessageFromButtons } from '../whatsappBuilders';
import type { WhatsAppListMessage } from '../domain/intent/whatsappTemplates';
import { formatBotUserMessage } from './productQuery/utils';
import { getBusinessConfig } from './businessConfig.service';
import { isReservationAgentEnabled } from '../config/env';

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
      payload: 'VIEW_ORDER',
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

  const headerText = ``;
  const bodyText = customBodyText?.trim()
    ? formatBotUserMessage(`Bienvenido a ${businessName}`, '👋', customBodyText.trim())
    : formatBotUserMessage(
        `Bienvenido a ${businessName}`,
        '👋',
        `¡Hola! Soy el asistente de IA de *${businessName}*.\n\n¿En qué te puedo ayudar?`
      );

  return buildListMessageFromButtons(
    bodyText,
    buttons,
    'Ver opciones',
    headerText,
    'Seleccioná una opción para continuar'
  );
};
