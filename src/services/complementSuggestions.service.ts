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
import type { business as Business } from '@prisma/client';
import { formatBotUserMessage } from './productQuery';
import { buildComplementarySuggestionsWithLlm } from './ai/complementarySuggestion.ai.service';
import {
  computeSuggestComplementPermission,
  recordOpportunitySurfaced,
} from './intent/opportunities.service';
import { normalizeMetadata } from './productQuery/utils';
import type { ConversationMetadata } from './productQuery/types';
import { buildListMessageFromButtons, truncateDescription, truncateTitle } from '../whatsappBuilders';
import {
  buildShortcutsThenListBody,
  shortcutBullet,
} from '../whatsappBuilders/listShortcutsBody';

/** false si refused, esperando engaged tras 1ª ola, cooldown o TTL. */
export function canSurfaceComplementOpportunity(metadata: unknown): boolean {
  const meta = normalizeMetadata(metadata) as ConversationMetadata;
  const entry = meta.intentLedger?.SUGERIR_COMPLEMENTO ?? {};
  return computeSuggestComplementPermission(entry).granted;
}

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
 * Cuerpo de gestión de pedido (post-add y ver carrito): atajos primero,
 * lista WA como alternativa.
 */
export function buildAddItemShortcutsFollowUpBody(options?: {
  includeEditAddressHint?: boolean;
  /** Vista de carrito: ofrecer cancelar el pedido en curso. */
  includeCancelHint?: boolean;
}): string {
  const bullets = [
    shortcutBullet('Menú'),
    shortcutBullet('Modificar', 'pedido'),
    shortcutBullet('Finalizar', 'pedido'),
    shortcutBullet('Notas', 'del pedido'),
  ];
  if (options?.includeEditAddressHint) {
    bullets.push(shortcutBullet('Dirección', 'del pedido'));
  }
  if (options?.includeCancelHint) {
    bullets.push(shortcutBullet('Cancelar', 'pedido'));
  }
  return buildShortcutsThenListBody('Escribí:', bullets);
}
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
    footer: { text: 'Elegí o escribí' },
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

export type ComplementSuggestionListItem = {
  id: string;
  name: string;
  categoryName: string;
};

/**
 * Lista WA de sugerencias de complemento + filas mínimas de gestión.
 * Body = bridge (post-add) o pitch (materialización diferida).
 */
export function buildComplementSuggestionsListMessage(params: {
  title: string;
  titleEmoji: string;
  /** Texto principal bajo el título (bridge o pitch). */
  bodyPlain: string;
  items: ComplementSuggestionListItem[];
  /** Incluir Modificar / Finalizar además de Ver menú (post-add / señal híbrida). */
  includeManagementRows?: boolean;
}): WhatsAppListMessage {
  const { title, titleEmoji, bodyPlain, items, includeManagementRows = false } = params;
  const suggestionBody = formatBotUserMessage(
    title,
    titleEmoji,
    `${bodyPlain.trim()}\n\nTocá el botón y elegí 👇`
  );

  const suggestionButtons = items.map((row) => ({
    title: truncateTitle(row.name),
    payload: `ADD_ITEM:${row.id}:1`,
    description: truncateDescription(row.categoryName, 72),
    // Una sección por categoría cuando hay varias (hasta 2 tags en la ola).
    sectionTitle: truncateTitle(row.categoryName || 'Sugerencias', 24),
  }));

  if (includeManagementRows) {
    suggestionButtons.push(
      {
        title: 'Modificar pedido',
        payload: 'VIEW_CART_FOR_EDITION',
        description: 'Cantidades, ítems y revisión',
        sectionTitle: 'Pedido',
      },
      {
        title: 'Finalizar pedido',
        payload: 'CHECKOUT',
        description: 'Ir al checkout',
        sectionTitle: 'Pedido',
      }
    );
  }

  suggestionButtons.push({
    title: 'Ver menú completo',
    payload: 'VIEW_MENU',
    description: 'Todas las categorías',
    sectionTitle: 'Menú',
  });

  return buildListMessageFromButtons(
    suggestionBody,
    suggestionButtons,
    'Ver sugerencias',
    '',
    'Elegí o escribí'
  );
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

  const listMessage = buildComplementSuggestionsListMessage({
    title: snapshot.title,
    titleEmoji: snapshot.titleEmoji,
    bodyPlain: snapshot.pitchBody,
    items: ordered.map((row) => ({
      id: row.id,
      name: row.name,
      categoryName: row.menu_category.name,
    })),
  });

  await clearComplementSuggestionSnapshot(ctx.conversation.id);
  await createConversationMessage(ctx.conversation.id, 'ai', listMessage.body.text, true);
  await updateConversationLastMessageAt(ctx.conversation.id);

  return listResponse(listMessage);
}

/**
 * Arma follow-up post-add / señal híbrida desde un bundle del builder LLM.
 * Persiste snapshot, registra Opportunity y devuelve la lista (o null).
 */
export async function presentComplementSuggestionBundle(params: {
  conversationId: string;
  metadata: unknown;
  bundle: {
    snapshot: ComplementSuggestionSnapshot;
    bridgeMessagePlain: string;
    items: Array<{ id: string; name: string; categoryName: string }>;
  };
}): Promise<WhatsAppListMessage | null> {
  const { conversationId, metadata, bundle } = params;
  if (bundle.items.length === 0) return null;

  await persistComplementSuggestionSnapshot(conversationId, bundle.snapshot);

  const listMessage = buildComplementSuggestionsListMessage({
    title: bundle.snapshot.title,
    titleEmoji: bundle.snapshot.titleEmoji,
    bodyPlain: bundle.bridgeMessagePlain,
    items: bundle.items,
    includeManagementRows: true,
  });

  await recordOpportunitySurfaced(conversationId, 'SUGERIR_COMPLEMENTO', metadata, {
    offeredProductIds: bundle.items.map((i) => i.id),
  });
  await clearComplementSuggestionSnapshot(conversationId);
  await createConversationMessage(conversationId, 'ai', listMessage.body.text, true);
  await updateConversationLastMessageAt(conversationId);

  return listMessage;
}

/**
 * Intenta decidir (LLM) y presentar sugerencias de complemento.
 * Null si presupuesto agotado, skip del modelo, sin catálogo o error.
 */
export async function tryPresentComplementSuggestions(params: {
  business: Business;
  conversationId: string;
  metadata: unknown;
  draftOrderId: string;
  lastAddedMenuItemId: string;
  maxItems?: number;
}): Promise<WhatsAppListMessage | null> {
  const {
    business,
    conversationId,
    metadata,
    draftOrderId,
    lastAddedMenuItemId,
    maxItems = 5,
  } = params;

  if (!canSurfaceComplementOpportunity(metadata)) {
    return null;
  }

  try {
    const bundle = await buildComplementarySuggestionsWithLlm(business, {
      businessId: business.id,
      draftOrderId,
      lastAddedMenuItemId,
      maxItems,
    });
    if (!bundle) return null;

    return presentComplementSuggestionBundle({
      conversationId,
      metadata,
      bundle: {
        snapshot: bundle.snapshot,
        bridgeMessagePlain: bundle.bridgeMessagePlain,
        items: bundle.items.map((i) => ({
          id: i.id,
          name: i.name,
          categoryName: i.categoryName,
        })),
      },
    });
  } catch (err) {
    console.error('[complement] tryPresentComplementSuggestions failed', err);
    return null;
  }
}
