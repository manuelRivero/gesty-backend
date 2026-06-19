import type { EnrichedContext, HandlerResult } from '../controllers/webhook/types';
import { listResponse, textResponse } from '../controllers/webhook/utils';
import {
  COMPLEMENT_METADATA_KEY,
  type ComplementSuggestionSnapshot,
  parseComplementSnapshot,
} from '../domain/complementSuggestions.schema';
import type { WhatsAppListMessage } from '../domain/intent/whatsappTemplates';
import { prisma } from '../lib/prisma';
import {
  createConversationMessage,
  omitConversationMetadataKeys,
  patchConversationMetadata,
  updateConversationLastMessageAt,
} from '../repositories';
import { formatBotUserMessage } from './productQuery';
import { buildListMessageFromButtons, truncateDescription, truncateTitle } from '../whatsappBuilders';

export async function persistComplementSuggestionSnapshot(
  conversationId: string,
  snapshot: ComplementSuggestionSnapshot
): Promise<void> {
  await patchConversationMetadata(conversationId, {
    [COMPLEMENT_METADATA_KEY]: snapshot,
  });
}

export async function clearComplementSuggestionSnapshot(
  conversationId: string
): Promise<void> {
  await omitConversationMetadataKeys(conversationId, [COMPLEMENT_METADATA_KEY]);
}

export type AddItemFollowUpListOptions = {
  /** Fila extra si el cliente ya tiene dirección por defecto. */
  includeEditAddressRow?: boolean;
};

/**
 * Segundo mensaje tras agregar al carrito: gestión del pedido (menú, carrito, checkout, zonas por tag).
 * Cabecera: 🤖 + *Gestión de pedido*; el cuerpo va aparte (solo texto descriptivo, sin repetir título).
 */
export function buildAddItemShortcutsFollowUpList(
  bodyPlain: string,
  options?: AddItemFollowUpListOptions
): WhatsAppListMessage {
  const rows: WhatsAppListMessage['action']['sections'][0]['rows'] = [
    {
      id: 'VIEW_MENU',
      title: 'Ver menú completo',
      description: 'Todas las categorías',
    },
    {
      id: 'VIEW_CART_FOR_EDITION',
      title: 'Modificar pedido',
      description: 'Cantidades, ítems y revisión',
    },
    {
      id: 'CHECKOUT',
      title: 'Finalizar pedido',
      description: 'Ir al checkout',
    },
  ];

  if (options?.includeEditAddressRow) {
    rows.push({
      id: 'EDIT_ADDRESS',
      title: 'Editar dirección',
      description: 'Cambiar entrega',
    });
  }

  rows.push(
    {
      id: 'MENU_BY_TAG:STARTER:1',
      title: 'Ver entradas',
      description: 'Solo entradas',
    },
    {
      id: 'MENU_BY_TAG:MAIN:1',
      title: 'Ver platos principales',
      description: 'Solo principales',
    },
    {
      id: 'MENU_BY_TAG:DRINK:1',
      title: 'Ver bebidas',
      description: 'Solo bebidas',
    },
    {
      id: 'MENU_BY_TAG:DESSERT:1',
      title: 'Ver postres',
      description: 'Solo postres',
    }
  );

  return {
    type: 'list',
    header: { type: 'text', text: '🤖\n\n*Gestión de pedido*' },
    body: { text: bodyPlain.trim() },
    footer: { text: 'Elegí una opción' },
    action: {
      button: 'Ver opciones',
      sections: [
        {
          title: 'Opciones',
          rows,
        },
      ],
    },
  };
}

/**
 * Construye la lista de sugerencias desde metadata, valida borrador y limpia estado.
 */
export async function materializeComplementSuggestionsList(
  ctx: EnrichedContext
): Promise<HandlerResult | null> {
  const raw = (ctx.conversationState?.metadata as Record<string, unknown> | null)?.[
    COMPLEMENT_METADATA_KEY
  ];
  const snapshot = parseComplementSnapshot(raw);
  if (!snapshot) {
    return textResponse(
      formatBotUserMessage(
        'Sugerencias no disponibles',
        '📋',
        'Explorá el menú para seguir armando tu pedido.'
      )
    );
  }

  if (snapshot.businessId !== ctx.business.id) {
    await clearComplementSuggestionSnapshot(ctx.conversation.id);
    return textResponse(
      formatBotUserMessage(
        'Sugerencias expiradas',
        '⏰',
        'Elegí platos desde el menú.'
      )
    );
  }

  const draft = await prisma.draft_order.findFirst({
    where: {
      id: snapshot.draftOrderId,
      business_id: ctx.business.id,
      customer_phone: ctx.customer.phone_number,
      status: 'active',
    },
    select: { id: true },
  });

  if (!draft) {
    await clearComplementSuggestionSnapshot(ctx.conversation.id);
    return textResponse(
      formatBotUserMessage(
        'Pedido actualizado',
        '🛒',
        'Tu pedido cambió; las sugerencias ya no aplican.\n\nSeguí comprando desde el menú.'
      )
    );
  }

  const idOrder = snapshot.orderedItemIds;
  if (idOrder.length === 0) {
    await clearComplementSuggestionSnapshot(ctx.conversation.id);
    return null;
  }

  const rows = await prisma.menu_item.findMany({
    where: {
      id: { in: idOrder },
      business_id: ctx.business.id,
      is_available: true,
    },
    select: {
      id: true,
      name: true,
      menu_category: { select: { name: true } },
    },
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = idOrder.map((id) => byId.get(id)).filter(Boolean) as Array<{
    id: string;
    name: string;
    menu_category: { name: string };
  }>;

  if (ordered.length === 0) {
    await clearComplementSuggestionSnapshot(ctx.conversation.id);
    return textResponse(
      formatBotUserMessage(
        'Productos no disponibles',
        '📋',
        'Los productos sugeridos ya no están disponibles.\n\nProbá otra opción desde el menú.'
      )
    );
  }

  const suggestionBody = formatBotUserMessage(
    snapshot.title,
    snapshot.titleEmoji,
    `${snapshot.pitchBody}\n\nTocá el botón y elegí 👇`
  );

  const suggestionButtons = ordered.map((row) => ({
    title: truncateTitle(row.name),
    payload: `ADD_ITEM:${row.id}:1`,
    description: truncateDescription(row.menu_category.name, 72),
    sectionTitle: 'Sugerencias',
  }));
  suggestionButtons.push({
    title: 'Ver menú completo',
    payload: 'VIEW_MENU',
    description: 'Todas las categorías',
    sectionTitle: 'Menú',
  });

  const listMessage = buildListMessageFromButtons(
    suggestionBody,
    suggestionButtons,
    'Ver sugerencias',
    '',
    'Podés sumar con un toque'
  );

  await clearComplementSuggestionSnapshot(ctx.conversation.id);
  await createConversationMessage(ctx.conversation.id, 'ai', suggestionBody, true);
  await updateConversationLastMessageAt(ctx.conversation.id);

  return listResponse(listMessage);
}
