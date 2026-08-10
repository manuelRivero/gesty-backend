// services/cartService.ts

import {
  Prisma,
  business,
  conversation,
  customer,
  draft_order_item,
  menu_item,
} from "@prisma/client";
import type { MenuCategoryTag } from "@prisma/client";
import type { ConversationMetadata } from "./productQuery/types";
import { prisma } from "../lib/prisma";
import {
  createConversationMessage,
  findBusinessByPhoneNumberId,
  findOrCreateConversationState,
  omitConversationMetadataKeys,
  patchConversationMetadata,
  updateConversationLastMessageAt,
  updateConversationState,
} from "../repositories";
import { findOrCreateCustomer } from "../repositories/customer.repository";
import { createOrGetOpenConversation } from "../repositories/conversation.repository";
import { WhatsAppWebhookPayload } from "../controllers/webhook/types";
import { WhatsAppInteractiveMessage, WhatsAppListMessage } from "../domain/intent/whatsappTemplates";
import { buildListMessageFromButtons } from '../whatsappBuilders';
import {
  buildAddItemShortcutsFollowUpBody,
  buildAddItemShortcutsFollowUpList,
  tryPresentComplementSuggestions,
} from './complementSuggestions.service';
import { formatBotUserMessage } from './productQuery';
import { wrapWhatsAppBold } from '../utils/whatsappBold';
import { clearLastOffer } from './lastOffer.service';
import {
  buildCartItemNotFoundMessage,
  buildCartProductNotFoundMessage,
  EMPTY_CART_BOT_MESSAGE,
  NO_CART_ITEMS_TO_REMOVE_BOT_MESSAGE,
} from './productQuery/botMessages';
import {
  buildMetadataValue,
  normalizeMetadata,
} from './productQuery/utils';
import { ConversationIntent } from "../types/conversationIntent";
import { handleDraftOrder, handleDraftOrderItem } from "./order.service";
import { computeOrderPricing, formatItemPriceForChat } from "./pricing.service";
import { resolveEffectivePrice } from "../helpers/menuItemPrice.helper";
import { resolveDeliveryContext } from "./deliveryFee.service";
import {
  formatCartGuidanceBlock,
  syncOrderCoverageToConversationState,
} from "./orderPortionCoverage";
import { MENU_SUGGESTION_ORDER } from "../helpers/complementaryMenu.helper";
import { truncateTitle } from "../whatsappBuilders";
import { hasVariations } from "./menu/menuItemVariations";

const SECTION_TITLE: Record<MenuCategoryTag, string> = {
  STARTER: "Entradas",
  MAIN: "Platos principales",
  DRINK: "Bebidas",
  SIDE: "Guarniciones",
  DESSERT: "Postres",
  OTHER: "Otros",
};

/** Orden de secciones en el resumen del pedido (post–agregar ítem). */
const ORDER_SECTION_TAGS: MenuCategoryTag[] = [
  ...MENU_SUGGESTION_ORDER,
  "OTHER",
];

type DraftLineForSection = {
  quantity: number;
  notes?: string | null;
  variation?: string | null;
  menu_item: {
    name: string | null;
    menu_category: {
      category_tag: MenuCategoryTag | null;
      name: string | null;
    } | null;
  } | null;
};

/**
 * Agrupa líneas del borrador por categoría y arma texto con secciones (*título*) y cantidad × producto.
 */
function formatDraftOrderSectionsForWhatsApp(
  lines: DraftLineForSection[],
  heading: string = "*Tu pedido*"
): string {
  type Bucket = { title: string; lines: string[] };
  const buckets = new Map<string, Bucket>();

  for (const row of lines) {
    const name = row.menu_item?.name?.trim() || "Producto";
    const q = row.quantity;
    const tag = row.menu_item?.menu_category?.category_tag;
    const catName = row.menu_item?.menu_category?.name?.trim();

    let key: string;
    let title: string;
    if (tag != null) {
      key = tag;
      title = SECTION_TITLE[tag] ?? catName ?? "Otros";
    } else {
      const slug = catName || "sin-categoría";
      key = `__extra__:${slug}`;
      title = catName || "Sin categoría";
    }

    if (!buckets.has(key)) {
      buckets.set(key, { title, lines: [] });
    }
    // La variación es parte de la identidad de la línea (D4): sin mostrarla,
    // el cliente no puede distinguir sus dos pizzas de sabores distintos.
    const variationSuffix = row.variation?.trim() ? ` (${row.variation.trim()})` : "";
    const noteSuffix = row.notes?.trim() ? ` _(${row.notes.trim()})_` : "";
    buckets.get(key)!.lines.push(`${q}× ${name}${variationSuffix}${noteSuffix}`);
  }

  // Heading vacío: el título ya va en el header del mensaje (evita "Tu pedido actual" duplicado).
  const parts: string[] = heading.trim() ? [heading.trim()] : [];
  const used = new Set<string>();

  for (const tag of ORDER_SECTION_TAGS) {
    const b = buckets.get(tag);
    if (!b?.lines.length) continue;
    parts.push("", `*${b.title}*`, b.lines.join("\n"));
    used.add(tag);
  }

  const restKeys = [...buckets.keys()]
    .filter((k) => !used.has(k))
    .sort();
  for (const k of restKeys) {
    const b = buckets.get(k)!;
    if (!b.lines.length) continue;
    parts.push("", `*${b.title}*`, b.lines.join("\n"));
  }

  return parts.join("\n").trim();
}

interface ConfirmRemoveItemResult {
  message: WhatsAppInteractiveMessage | null;
  errorMessage?: string;
}

interface RemoveItemResult {
  message: WhatsAppInteractiveMessage | null;
  errorMessage?: string;
}

async function clearLastListSuggestedQuantityFromConversation(
  conversationId: string
): Promise<void> {
  const state = await findOrCreateConversationState(conversationId);
  const meta = normalizeMetadata(state.metadata) as ConversationMetadata;
  if (meta.lastListSuggestedQuantity == null) return;
  const { lastListSuggestedQuantity: _r, ...rest } = meta;
  void _r;
  await updateConversationState(conversationId, {
    metadata: buildMetadataValue(rest),
  });
}

/**
 * Lista de WhatsApp para que el cliente elija la variación de un platillo
 * antes de agregarlo (D7: listas, no botones, porque un menú de pizzas se
 * pasa de 3 opciones al instante). Cada fila viaja como
 * `ADD_ITEM:<uuid>:<qty>:v<index>`, que `parseAddItemButtonPayload` resuelve.
 *
 * Respeta el límite de 10 filas de una lista de WhatsApp sin paginado (D8):
 * si por datos legacy hubiera más, trunca y loguea, no falla en silencio.
 */
export function buildVariationPickerList(
  item: { id: string; name: string | null; variations: string[] },
  qty: number
): WhatsAppListMessage {
  const name = item.name?.trim() || "Este platillo";
  let variations = item.variations;
  if (variations.length > 10) {
    console.warn(
      `[buildVariationPickerList] ${item.id} tiene ${variations.length} variaciones, truncando a 10 (D8)`
    );
    variations = variations.slice(0, 10);
  }

  return {
    type: "list",
    header: { type: "text", text: truncateTitle(name) },
    body: {
      text: `*${name}* viene en varias variedades. ¿Cuál querés?`,
    },
    footer: { text: "Elegí una opción" },
    action: {
      button: "Elegir variedad",
      sections: [
        {
          title: "Variedades",
          rows: variations.map((variation, index) => ({
            id: `ADD_ITEM:${item.id}:${qty}:v${index}`,
            title: truncateTitle(variation),
          })),
        },
      ],
    },
  };
}

/** Respuesta de agregar ítem: texto de confirmación + lista de gestión del pedido. */
export type AddItemMessageResult =
  | string
  | {
      main: string;
      mainFollowUpList: WhatsAppListMessage;
    };

export const buildRemoveItemMessage = async (
  business: business,
  conversation: conversation,
  itemIdentifier: string
): Promise<RemoveItemResult> => {
  const cart = await prisma.orders.findFirst({
    where: { conversation_id: conversation.id },
    include: {
      order_item: {
        include: { menu_item: true }
      }
    }
  });
  if (!cart || cart.order_item.length === 0) {
    const errorText = 'No tenés platillos en tu orden para remover.';
    await createConversationMessage(conversation.id, 'ai', errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return { message: null, errorMessage: errorText };
  }


  const matchingItem = cart.order_item.find(ci =>
    ci.menu_item.id === itemIdentifier ||
    ci.menu_item.name.toLowerCase().includes(itemIdentifier.toLowerCase())
  );

  if (!matchingItem) {
    const errorText = buildCartItemNotFoundMessage(itemIdentifier);
    await createConversationMessage(conversation.id, 'ai', errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return { message: null, errorMessage: errorText };
  }
  const message: WhatsAppInteractiveMessage = {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Pedido actualizado' },
      footer: {
        text: '¿Querés seguir comprando o finalizar tu orden?'
      },
      body: {
        text: `Se removiò el platillo *${matchingItem.menu_item.name}*
       (cantidad: ${matchingItem.quantity}) de tu orden. 
       \n¿Querés seguir comprando?
       \n¿Querés finalizar tu orden?` },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: { id: 'VIEW_MENU', title: 'Seguir comprando' }
          },
          { type: 'reply', reply: { id: 'CHECKOUT', title: 'Finalizar' } }
        ]
      }
    }
  };
  return { message: message };
};

export const buildAddItemMessage = async (
  business: business,
  conversation: conversation,
  menuItemId: string,
  customer: customer,
  addQuantity: number = 1,
  /**
   * 'add' (default): suma `addQuantity` a lo que ya había en el carrito
   * (semántica histórica de ADD_ITEM/INCREASE_ITEM). 'set': fija la cantidad
   * final en `addQuantity`, sin importar cuánto había antes — para
   * instrucciones de cantidad absoluta ("quiero solamente 1 de X", "que
   * queden 2"), que antes se trataban como aditivas por error (MODIFY_QUANTITY
   * llamaba esta misma función sin distinguir el modo).
   */
  mode: 'add' | 'set' = 'add',
  /** Variación elegida por el cliente (D4/D3); `null` para platillos sin variaciones. */
  variation: string | null = null
): Promise<AddItemMessageResult> => {
  const qty = Math.min(99, Math.max(1, Math.floor(addQuantity)));

    const cart = await handleDraftOrder(business, customer);
    if (!cart) return 'Error al crear el pedido.';
  

  const item = await prisma.menu_item.findFirst({
    where: { id: menuItemId, business_id: business.id, is_available: true },
    include: {
      menu_category: { select: { category_tag: true } },
      menu_item_price: {
        where: {
          is_active: true,
          valid_from: { lte: new Date() },
          OR: [{ valid_to: null }, { valid_to: { gte: new Date() } }]
        },
        orderBy: { valid_from: 'desc' },
        take: 1
      }
    }
  });

  if (!item) {
    const errorText = 'Producto no encontrado o no disponible.';
    await createConversationMessage(conversation.id, 'ai', errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return errorText;
  }

  const resolved = resolveEffectivePrice(item);
  const unitDec = resolved.finalPrice;

  // La variación es parte de la identidad de la línea (D4): una pizza
  // especial y una de roquefort son dos líneas, no una con cantidad 2.
  const existingItem = await prisma.draft_order_item.findFirst({
    where: { draft_order_id: cart.id, product_id: item.id, variation }
  });

  if (existingItem) {
    const newQ = mode === 'set' ? qty : existingItem.quantity + qty;
    await prisma.draft_order_item.update({
      where: { draft_order_id: cart.id, id: existingItem.id },
      data: {
        quantity: newQ,
        unit_price: unitDec,
        total_price: unitDec.mul(newQ),
        list_price: resolved.hasDiscount ? resolved.listPrice : null,
        discount_amount: resolved.hasDiscount ? resolved.discountAmount : null,
      },
    });
  } else {
    await prisma.draft_order_item.create({
      data: {
        draft_order_id: cart.id,
        product_id: item.id,
        quantity: qty,
        unit_price: unitDec,
        total_price: unitDec.mul(qty),
        list_price: resolved.hasDiscount ? resolved.listPrice : null,
        discount_amount: resolved.hasDiscount ? resolved.discountAmount : null,
        variation,
      },
    });
  }

  const total = await prisma.draft_order_item.aggregate({
    where: { draft_order_id: cart.id },
    _sum: { total_price: true }
  });

  const draftLinesForSections = await prisma.draft_order_item.findMany({
    where: { draft_order_id: cart.id },
    include: {
      menu_item: {
        select: {
          name: true,
          menu_category: { select: { category_tag: true, name: true } },
        },
      },
    },
    orderBy: { id: "asc" },
  });
  const orderSectionsBlock =
    formatDraftOrderSectionsForWhatsApp(draftLinesForSections);

  // Obtener fulfillment_type del draft (puede ser null si aún no eligió)
  const draftWithType = await prisma.draft_order.findUnique({
    where: { id: cart.id },
    select: { fulfillment_type: true }
  });
  const fulfillmentType = draftWithType?.fulfillment_type ?? null;

  let addressLine = '';
  let hasDeliveryAddress = false;

  if (fulfillmentType === 'TAKE_AWAY') {
    const localAddress = business.street_address;
    if (localAddress) {
      addressLine = `\n\n🏪 Retiro en local: ${localAddress}`;
      if (business.address_notes) {
        addressLine += ` — ${business.address_notes}`;
      }
      addressLine += '\n📦 Modalidad: *Retiro en el local*';
    } else {
      addressLine = '\n\n📦 Modalidad: *Retiro en el local*';
    }
  } else if (fulfillmentType === 'DELIVERY') {
    const defaultAddress = await prisma.customer_address.findFirst({
      where: { customer_id: customer.id, is_default: true },
      select: { street_address: true }
    });
    hasDeliveryAddress = Boolean(defaultAddress?.street_address);
    if (hasDeliveryAddress) {
      addressLine = `\n\n📍 Dirección de entrega: ${defaultAddress!.street_address}`;
    }
  }

  const coverage = await syncOrderCoverageToConversationState(
    conversation.id,
    business.id,
    customer.phone_number
  );
  const guidanceBlock = formatCartGuidanceBlock(coverage).trim();
  const guidanceSuffix = guidanceBlock ? `\n\n${guidanceBlock}\n\n` : '\n\n';

  const qtyLine = qty > 1 ? `${wrapWhatsAppBold(String(qty))} × ` : '';
  const priceLine = formatItemPriceForChat(resolved);
  const discountLine = resolved.hasDiscount
    ? ` ✨ ${wrapWhatsAppBold('¡Precio con descuento!')} ${priceLine}`
    : '';
  const variationLine = variation ? ` (${variation})` : '';
  const itemBold = wrapWhatsAppBold(item.name);
  const actionLine =
    mode === 'set'
      ? `Ahora tenés ${qtyLine}${itemBold}${variationLine} en tu pedido.`
      : `${qtyLine}${itemBold}${variationLine} sumado a tu pedido.`;
  const mainInner =
    `${actionLine}${discountLine}\n\n${orderSectionsBlock}${guidanceSuffix}` +
    `Total: $${total._sum.total_price || 0}${addressLine}\n\n` +
    `En el siguiente mensaje tenés las opciones para seguir.`;

  const mainText = formatBotUserMessage(
    mode === 'set' ? 'Cantidad actualizada' : 'Producto agregado',
    '🛒',
    mainInner
  );

  await createConversationMessage(conversation.id, 'ai', mainText, false);
  await updateConversationLastMessageAt(conversation.id);

  // Cierra shortlist tipable previo (product query / ola anterior) para que el
  // próximo mensaje libre no re-sume un candidato viejo (p. ej. doble aguadito).
  await omitConversationMetadataKeys(conversation.id, [
    'pendingProductSelection',
    'pendingQuestion',
    'candidateProductIds',
  ]);

  const includeAddress = fulfillmentType === 'DELIVERY' && hasDeliveryAddress;

  const state = await findOrCreateConversationState(conversation.id);
  const suggestionList = await tryPresentComplementSuggestions({
    business,
    conversationId: conversation.id,
    metadata: state.metadata,
    draftOrderId: cart.id,
    lastAddedMenuItemId: menuItemId,
    maxItems: 5,
  });
  if (suggestionList) {
    return { main: mainText, mainFollowUpList: suggestionList };
  }

  const followUpBody = buildAddItemShortcutsFollowUpBody({
    includeEditAddressHint: includeAddress,
  });

  const mainFollowUpList = buildAddItemShortcutsFollowUpList(followUpBody, {
    includeEditAddressRow: includeAddress,
  });
  await createConversationMessage(conversation.id, 'ai', followUpBody, false);
  await updateConversationLastMessageAt(conversation.id);

  return { main: mainText, mainFollowUpList };
};

export const handleAddItemFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  menuItemId: string,
  addQuantity: number = 1,
  mode: 'add' | 'set' = 'add',
  variation: string | null = null
): Promise<AddItemMessageResult | null> => {

  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !menuItemId) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  await findOrCreateConversationState(conversation.id);

  // handleDraftOrder ya fija expires_at si crea el draft; la renovación por
  // actividad del usuario la maneja touchSession, no este handler.
  const draftOrder = await handleDraftOrder(business, customer);
  const result = await buildAddItemMessage(
    business,
    conversation,
    menuItemId,
    customer,
    addQuantity,
    mode,
    variation
  );
  if (
    typeof result === 'object' &&
    result !== null &&
    'main' in result
  ) {
    await clearLastOffer(conversation.id);
    await clearLastListSuggestedQuantityFromConversation(conversation.id);
    const { markComplementEngagedIfOffered } = await import('./intent/opportunities.service');
    await markComplementEngagedIfOffered(conversation.id, menuItemId);
  }
  return result;
};

export const buildConfirmRemoveItemMessage = async (
  business: business,
  conversation: conversation,
  customer: customer,
  itemIdentifier: string // id del item
): Promise<ConfirmRemoveItemResult> => {

  // Buscar carrito activo
  const cartItems = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: customer.phone_number,
      status: 'active'
    },
    include: {
      draft_order_item: {  // ← Nombre correcto según tu schema
        include: { menu_item: true }
      }
    }
  });

  if (!cartItems || cartItems.draft_order_item.length === 0) {
    const errorText = NO_CART_ITEMS_TO_REMOVE_BOT_MESSAGE;
    await createConversationMessage(conversation.id, 'ai', errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return { message: null, errorMessage: errorText };
  }

  // Buscar ítem que coincida por ID de producto
  const matchingItem = cartItems.draft_order_item.find(ci =>
    ci.menu_item?.id === itemIdentifier
  );

  if (!matchingItem) {
    const errorText = buildCartItemNotFoundMessage(itemIdentifier);
    await createConversationMessage(conversation.id, 'ai', errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return { message: null, errorMessage: errorText };
  }

  // Construir mensaje de confirmación interactivo
  const confirmMessage: WhatsAppInteractiveMessage = {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: {
        type: 'text',
        text: '¿Remover ítem?'
      },
      body: {
        text: formatBotUserMessage(
          'Confirmar remoción',
          '🗑️',
          `¿Querés remover *${matchingItem.menu_item?.name}* (cantidad: ${matchingItem.quantity}) de tu pedido?`
        ),
      },
      footer: {
        text: 'Esta acción no se puede deshacer'
      },
      action: {
        buttons: [
          {
            type: 'reply',
            reply: {
              id: `CONFIRM_REMOVE:${matchingItem.menu_item?.id}`,
              title: '✅ Sí, remover'
            }
          },
          {
            type: 'reply',
            reply: {
              id: 'CANCEL_REMOVE',
              title: '❌ No, cancelar'
            }
          }
        ]
      }
    }
  };

  // Guardar en metadata que estamos esperando confirmación. `patchConversationMetadata`
  // mergea — `updateConversationState({ metadata: {...} })` pisaría el resto de la
  // metadata de la conversación (checkout_active, intentLedger, etc.), no solo estas claves.
  await patchConversationMetadata(conversation.id, {
    pendingAction: 'CONFIRM_REMOVE',
    pendingItemId: matchingItem.menu_item?.id ?? '',
    pendingItemName: matchingItem.menu_item?.name ?? '',
    pendingActionAt: new Date().toISOString(),
  });

  await createConversationMessage(
    conversation.id,
    'ai',
    `Solicitud de confirmación para remover ${matchingItem.menu_item?.name ?? ''}`,
    false
  );
  await updateConversationLastMessageAt(conversation.id);

  return { message: confirmMessage };
};

/**
 * Ejecuta la eliminación tras tocar "Sí, remover" (borrador + total + cobertura + metadata).
 */
export const executeRemoveDraftOrderItemFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  menuItemId: string
): Promise<WhatsAppInteractiveMessage | string | null> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !menuItemId) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  await findOrCreateConversationState(conversation.id);

  const draftOrder = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: customer.phone_number,
      status: "active",
    },
    include: {
      draft_order_item: { include: { menu_item: true } },
    },
  });

  if (!draftOrder?.draft_order_item.length) {
    const errorText =
      NO_CART_ITEMS_TO_REMOVE_BOT_MESSAGE;
    await createConversationMessage(conversation.id, "ai", errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return errorText;
  }

  const line = draftOrder.draft_order_item.find(
    (ci) => ci.product_id === menuItemId
  );
  if (!line) {
    const errorText = buildCartProductNotFoundMessage();
    await createConversationMessage(conversation.id, "ai", errorText, false);
    await updateConversationLastMessageAt(conversation.id);
    return errorText;
  }

  const removedName = line.menu_item?.name ?? "Producto";
  const removedQty = line.quantity;

  await prisma.$transaction(async (tx) => {
    await tx.draft_order_item.delete({ where: { id: line.id } });
    const items = await tx.draft_order_item.findMany({
      where: { draft_order_id: draftOrder.id },
    });
    const totalAmount = items.reduce(
      (acc, item) => acc.add(item.total_price),
      new Prisma.Decimal(0)
    );
    await tx.draft_order.update({
      where: { id: draftOrder.id },
      data: { total_amount: totalAmount },
    });
  });

  await omitConversationMetadataKeys(conversation.id, [
    "pendingAction",
    "pendingItemId",
    "pendingItemName",
    "pendingActionAt",
  ]);
  // No crea drafts nuevos (requiere uno existente con ítems): la renovación
  // del timeout ya la cubrió touchSession al inicio del turno.

  const coverage = await syncOrderCoverageToConversationState(
    conversation.id,
    business.id,
    customer.phone_number
  );
  const guidance = formatCartGuidanceBlock(coverage);
  const guide = guidance.trim() ? `\n\n${guidance.trim()}` : "";
  const currency = business.currency_code ?? draftOrder.currency ?? "ARS";

  const bodyText = `Se quitó *${removedName}* (cantidad: ${removedQty}) de tu pedido.${guide}\n\n¿Querés seguir comprando o volver al pedido?`;

  const successMessage: WhatsAppInteractiveMessage = {
    type: "interactive",
    interactive: {
      type: "button",
      header: { type: "text", text: "Pedido actualizado" },
      body: { text: bodyText },
      footer: { text: "Elegí una opción" },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: "VIEW_MENU", title: "Seguir comprando" },
          },
          { type: "reply", reply: { id: "VIEW_CART", title: "Ver pedido" } },
          { type: "reply", reply: { id: "CHECKOUT", title: "Finalizar" } },
        ],
      },
    },
  };

  await createConversationMessage(
    conversation.id,
    "ai",
    `Quitado del pedido: ${removedName} × ${removedQty}. Total actualizado (${currency}).`,
    false
  );
  await updateConversationLastMessageAt(conversation.id);

  return successMessage;
};

export const handleConfirmRemoveItemFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  itemIdentifier: string
): Promise<WhatsAppInteractiveMessage | string | null> => {

  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !itemIdentifier) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  await findOrCreateConversationState(conversation.id);

  const result = await buildConfirmRemoveItemMessage(
    business,
    conversation,
    customer,
    itemIdentifier
  );

  if (result.errorMessage) return result.errorMessage;
  return result.message;
};

export const handleRemoveItemFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  itemIdentifier: string
): Promise<WhatsAppInteractiveMessage | string | null> => {

  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !itemIdentifier) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  await findOrCreateConversationState(conversation.id);

  const result = await buildRemoveItemMessage(
    business,
    conversation,
    itemIdentifier
  );

  if (result.errorMessage) return result.errorMessage;
  return result.message;
};

export const handleShowCartForEditionFromWebhook = async (
  payload: WhatsAppWebhookPayload
): Promise<WhatsAppListMessage | WhatsAppInteractiveMessage | string | null> => {

  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  const coverageForEdition = await syncOrderCoverageToConversationState(
    conversation.id,
    business.id,
    customer.phone_number
  );

  // 🔎 Obtener items del carrito

  const cartItems = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: customer.phone_number,
      status: 'active'

    },
    include: {
      draft_order_item: {  // ← Nombre correcto según tu schema
        include: { menu_item: true }
      }
    }
  });

  if (!cartItems?.draft_order_item.length) {
    return buildListMessageFromButtons(
      EMPTY_CART_BOT_MESSAGE,
      [
        {
          title: 'Ver menú',
          payload: 'VIEW_MENU',
          description: 'Explorar platos disponibles',
          sectionTitle: 'Opciones'
        },
        {
          title: 'Hacer una consulta',
          payload: 'ASK_QUESTION',
          description: 'Resolver una duda',
          sectionTitle: 'Opciones'
        }
      ],
      'Ver opciones',
      '',
      'Seleccioná una opción para continuar'
    );
  }

  const guidanceEdition = formatCartGuidanceBlock(coverageForEdition).trim();
  const editionIntro = guidanceEdition
    ? `${guidanceEdition}\n\n*Este es tu pedido*`
    : '*Este es tu pedido*';

  return {
    type: 'list',
    header: {
      type: 'text',
      text: ''
    },
    body: {
      text: `${editionIntro}\n\nSelecciona el producto que querés modificar 👇`
    },
    footer: {
      text: 'Podrás cambiar cantidad o removerlo'
    },
    action: {
      button: 'Ver platillos',
      sections: [
        {
          title: 'Platillos en tu pedido',
          rows: cartItems.draft_order_item.map(item => ({
            id: `SELECT_CART_ITEM:${item.menu_item?.id ?? ''}`,
            title: `${item.quantity}x ${item.menu_item?.name ?? ''}`,
            description: item.notes?.trim() ? item.notes.trim() : 'Modificar o remover',
          }))
        }
      ]
    }
  };
};

/**
 * Construye el mensaje interactivo del carrito a partir de IDs directos.
 * Reutilizable desde el agente híbrido (señal present_cart) y desde handleViewCartFromWebhook.
 */
export const buildCartSummaryMessage = async (params: {
  businessId: string;
  customerPhone: string;
  conversationId: string;
  customerId: string;
  currencyCode: string | null;
  businessStreetAddress: string | null;
}): Promise<WhatsAppListMessage> => {
  const { businessId, customerPhone, conversationId, customerId, currencyCode, businessStreetAddress } = params;

  const cartItems = await prisma.draft_order.findFirst({
    where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
    include: {
      draft_order_item: {
        include: {
          menu_item: {
            include: { menu_category: { select: { category_tag: true, name: true } } },
          },
        },
      },
    },
  });

  if (!cartItems?.draft_order_item.length) {
    await syncOrderCoverageToConversationState(conversationId, businessId, customerPhone);
    return buildListMessageFromButtons(
      EMPTY_CART_BOT_MESSAGE,
      [
        { title: 'Ver menú', payload: 'VIEW_MENU', description: 'Explorar platos disponibles', sectionTitle: 'Opciones' },
        { title: 'Hacer una consulta', payload: 'ASK_QUESTION', description: 'Resolver una duda', sectionTitle: 'Opciones' },
      ],
      'Ver opciones',
      '',
      'Seleccioná una opción para continuar'
    );
  }

  const coverage = await syncOrderCoverageToConversationState(conversationId, businessId, customerPhone);
  const guidanceBlock = formatCartGuidanceBlock(coverage).trim();
  const guidanceMid = guidanceBlock ? `\n\n${guidanceBlock}\n\n` : '\n\n';

  const orderSectionsBlock = formatDraftOrderSectionsForWhatsApp(
    cartItems.draft_order_item as DraftLineForSection[],
    ''
  );
  const fulfillmentType = cartItems.fulfillment_type;

  const deliveryCtx = await resolveDeliveryContext({ customerId, businessId, fulfillmentType });
  const pricing = computeOrderPricing(cartItems.draft_order_item, { deliveryFee: deliveryCtx.deliveryFee });

  let deliveryLine = '';
  let hasDeliveryAddress = false;
  if (fulfillmentType === 'TAKE_AWAY') {
    deliveryLine = businessStreetAddress
      ? `\n🏪 *Retiro en local:* ${businessStreetAddress}`
      : '\n📦 *Modalidad:* Retiro en el local';
  } else if (fulfillmentType === 'DELIVERY') {
    const defaultAddress = await prisma.customer_address.findFirst({
      where: { customer_id: customerId, is_default: true },
      select: { street_address: true },
    });
    if (defaultAddress?.street_address) {
      hasDeliveryAddress = true;
      deliveryLine = `\n📍 *Entrega a:* ${defaultAddress.street_address}`;
    }
  }

  const subtotalLine = pricing.deliveryFee > 0
    ? `Subtotal: $${(pricing.subtotal - pricing.productDiscounts).toFixed(2)}\nEnvío: $${pricing.deliveryFee.toFixed(2)}\n`
    : '';
  const totalLine = `${subtotalLine}*Total: $${pricing.total.toFixed(2)} ${currencyCode ?? 'ARS'}*`;

  const includeAddress = fulfillmentType === 'DELIVERY' && hasDeliveryAddress;
  const shortcutsBody = buildAddItemShortcutsFollowUpBody({
    includeEditAddressHint: includeAddress,
    includeCancelHint: true,
  });

  const rows: WhatsAppListMessage['action']['sections'][0]['rows'] = [
    { id: 'VIEW_MENU', title: 'Ver menú completo', description: 'Todas las categorías' },
    {
      id: 'VIEW_CART_FOR_EDITION',
      title: 'Modificar pedido',
      description: 'Cantidades, ítems y revisión',
    },
    { id: 'CHECKOUT', title: 'Finalizar pedido', description: 'Ir al checkout' },
    { id: 'CANCEL_ORDER', title: 'Cancelar pedido', description: 'Vaciar y empezar de nuevo' },
  ];
  if (includeAddress) {
    rows.push({
      id: 'EDIT_ADDRESS',
      title: 'Editar dirección',
      description: 'Cambiar entrega',
    });
  }
  rows.push(
    { id: 'MENU_BY_TAG:STARTER:1', title: 'Ver entradas', description: 'Solo entradas' },
    { id: 'MENU_BY_TAG:MAIN:1', title: 'Ver platos principales', description: 'Solo principales' },
    { id: 'MENU_BY_TAG:DRINK:1', title: 'Ver bebidas', description: 'Solo bebidas' },
    { id: 'MENU_BY_TAG:DESSERT:1', title: 'Ver postres', description: 'Solo postres' }
  );

  return {
    type: 'list',
    header: { type: 'text', text: '🤖\n\n*Tu pedido actual* 🛒' },
    body: {
      text: `${orderSectionsBlock}${guidanceMid}${totalLine}${deliveryLine}\n\n${shortcutsBody}`,
    },
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
};

export const handleViewCartFromWebhook = async (
  payload: WhatsAppWebhookPayload
): Promise<WhatsAppListMessage | string | null> => {

  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  return buildCartSummaryMessage({
    businessId: business.id,
    customerPhone: customer.phone_number ?? from,
    conversationId: conversation.id,
    customerId: customer.id,
    currencyCode: business.currency_code ?? null,
    businessStreetAddress: business.street_address ?? null,
  });
};

export const handleCartItemSelectionFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  orderItemId: string | undefined
): Promise<WhatsAppListMessage | string | null> => {

  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];

  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !orderItemId || orderItemId === undefined) {
    return null;
  }

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);

  const conversationState = await findOrCreateConversationState(conversation.id);
  const draftOrder = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: customer.phone_number,
      status: 'active'
    },
    include: {
      draft_order_item: {  // ← Nombre correcto según tu schema
        include: { menu_item: true }
      }
    }
  });
  if (!draftOrder) {
    return 'No se encontró el pedido.'
  }

  // Buscar item del carrito
  const orderItem = draftOrder.draft_order_item.find(item => item.product_id === orderItemId);

  console.log('orderItem', orderItem);
  console.log('draftOrder', draftOrder);
  console.log('orderItemId', orderItemId);
  if (!orderItem) {
    return 'Ese producto no está en tu pedido.';
  }

  console.log('---- CART ITEM SELECTED ----');
  console.log('OrderItemId:', orderItem.id);
  console.log('Product:', orderItem);
  console.log('Quantity:', orderItem.quantity);
  console.log('----------------------------');

  // Guardar estado conversacional
  await updateConversationState(conversation.id, {
    metadata: {
      pendingAction: 'EDIT_CART',
      pendingItemId: orderItem.id,
      pendingItemName: orderItem.menu_item?.name
    }
  });

  const bodyText =
    `Seleccionaste *${orderItem.menu_item?.name}*\n` +
    `Cantidad actual: ${orderItem.quantity}\n\n` +
    `¿Qué deseas hacer?`;

  const interactiveMessage: WhatsAppListMessage = {
    type: 'list',
    header: {
      type: 'text',
      text: ''
    },
    body: {
      text: bodyText
    },
    footer: {
      text: 'Selecciona una opción'
    },
    action: {
      button: 'Opciones',
      sections: [
        {
          title: 'Gestión del pedido',
          rows: [
            {
              id: `INCREASE_ITEM_QUANTITY:${orderItem.menu_item?.id}`,
              title: '➕ Aumentar cantidad',
              description: 'Aumentar la cantidad del producto'
            },
            {
              id: `DECREASE_ITEM_QUANTITY:${orderItem.menu_item?.id}`,
              title: '➖ Disminuir cantidad',
              description: 'Disminuir la cantidad del producto'
            },
            {
              id: `CONFIRM_REMOVE:${orderItem.menu_item?.id}`,
              title: '🗑 Remover',
              description: 'Remover el producto del pedido'
            },
            {
              id: 'VIEW_CART',
              title: '⬅ Volver',
              description: 'Volver a la lista de productos'
            }
          ]
        }
      ]
    }
  };


  await createConversationMessage(conversation.id, 'ai', bodyText, false);
  await updateConversationLastMessageAt(conversation.id);

  return interactiveMessage;
};

export const handleSelectQuantityDecreaseItemFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  itemID: string | undefined
): Promise<WhatsAppListMessage | string | null> => {

  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !itemID || itemID === undefined) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  await findOrCreateConversationState(conversation.id);

  const draftOrder = await handleDraftOrder(business, customer);

  const draftOrderItem = await handleDraftOrderItem(draftOrder, itemID);


  if (!draftOrderItem) return 'Ese producto ya no está disponible en tu pedido.';

  return await buildSelectQuatityDecreaseItemMessage(draftOrderItem);
};

export const handleSelectQuantityIncreaseItemFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  itemID: string | undefined
): Promise<WhatsAppListMessage | string | null> => {

  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !itemID || itemID === undefined) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  await findOrCreateConversationState(conversation.id);

  const draftOrder = await handleDraftOrder(business, customer);
  const draftOrderItem = await handleDraftOrderItem(draftOrder, itemID);

  console.log('draftOrderItem handleSelectQuantityIncreaseItemFromWebhook', draftOrderItem);
  if (!draftOrderItem) return 'Ese producto ya no está disponible en tu pedido.';

  return await buildSelectQuantityIncreaseItemMessage(draftOrderItem);
};

const buildSelectQuatityDecreaseItemMessage = async (
  draftOrderItem: draft_order_item & { menu_item: menu_item | null },
): Promise<WhatsAppListMessage> => {

  const rowsList: {
    id: string
    title: string
    description: string
  }[] = [];

  const currentQty = draftOrderItem.quantity;

  // Caso especial: solo hay 1 unidad
  if (currentQty === 1) {

    rowsList.push({
      id: `CONFIRM_REMOVE:${draftOrderItem.menu_item?.id}`,
      title: '❌ Remover',
      description: 'Remover el platillo del pedido'
    });

  } else {

    // Nunca permitir disminuir hasta 0
    const maxDecrease = currentQty - 1;

    // Limitar para evitar listas gigantes
    const allowedOptions = Math.min(maxDecrease, 7);

    for (let amount = 1; amount <= allowedOptions; amount++) {
      rowsList.push({
        id: `DECREASE_ITEM:${draftOrderItem.menu_item?.id}:${amount}`,
        title: `Disminuir ${amount}`,
        description: `Reducir ${amount} del pedido`
      });
    }

    rowsList.push({
      id: `CONFIRM_REMOVE:${draftOrderItem.menu_item?.id}`,
      title: '❌ Remover',
      description: 'Remover el platillo del pedido'
    });
  }

  // siempre permitir volver
  rowsList.push({
    id: ConversationIntent.VIEW_CART,
    title: '⬅ Volver',
    description: 'Volver al pedido'
  });

  return {
    type: 'list',
    header: {
      type: 'text',
      text: draftOrderItem.menu_item?.name ?? 'Platillo'
    },
    body: {
      text: `Cantidad actual: ${currentQty}`
    },
    footer: {
      text: currentQty === 1
        ? 'Solo puedes remover el platillo'
        : 'Selecciona cuánto deseas disminuir'
    },
    action: {
      button: 'Seleccionar',
      sections: [
        {
          title: 'Opciones',
          rows: rowsList
        }
      ]
    }
  };
};

const buildSelectQuantityIncreaseItemMessage = async (
  draftOrderItem: draft_order_item & { menu_item: menu_item | null },
): Promise<WhatsAppListMessage> => {
  console.log('draftOrderItem buildSelectQuantityIncreaseItemMessage', draftOrderItem);
  const rowsList: {
    id: string
    title: string
    description: string
  }[] = [];

  const currentQty = draftOrderItem.quantity;
  const maxIncrease = 9;
  for (let amount = 1; amount <= maxIncrease; amount++) {
    rowsList.push({
      id: `INCREASE_ITEM:${draftOrderItem.menu_item?.id}:${amount}`,
      title: `Aumentar ${amount}`,
      description: `Aumentar ${amount} del pedido`
    });
  }

  // siempre permitir volver
  rowsList.push({
    id: ConversationIntent.VIEW_CART,
    title: '⬅ Volver',
    description: 'Volver al pedido'
  });

  return {
    type: 'list',
    header: {
      type: 'text',
      text: draftOrderItem.menu_item?.name ?? 'Platillo'
    },
    body: {
      text: `Cantidad actual: ${currentQty}`
    },
    footer: {
      text: 'Selecciona cuánto deseas aumentar'
    },
    action: {
      button: 'Seleccionar',
      sections: [
        {
          title: 'Opciones',
          rows: rowsList
        }
      ]
    }
  };
};

const buildDecreaseItemQuantitySuccessMessage = async (
  draftOrderItem: draft_order_item & { menu_item: menu_item | null },
  quantity: number,
  currencyCode: string,
  newQuantity: number,
  guidanceBlock?: string
): Promise<WhatsAppInteractiveMessage> => {
  const guide = guidanceBlock ? `\n\n${guidanceBlock}` : '';
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Pedido actualizado' },
      body: { text: `
      Se disminuyò la cantidad de ${quantity} para el platillo ${draftOrderItem.menu_item?.name} en el pedido. 
      \nCantidad actual: ${newQuantity}
      \nTotal: ${draftOrderItem.total_price.toNumber()} ${currencyCode}${guide}
      \n¿Querés seguir comprando? Escribe "Ver menu" para agregar más platillos.` },
      footer: { text: '¿Querés seguir comprando o finalizar tu orden?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'VIEW_CART', title: 'Volver al pedido' } },
          { type: 'reply', reply: { id: 'CHECKOUT', title: 'Finalizar pedido' } },
          { type: 'reply', reply: { id: 'CANCEL_ORDER', title: 'Cancelar pedido' } }
        ]
      }
    }
  };
};

const buildIncreaseItemQuantitySuccessMessage = async (
  draftOrderItem: draft_order_item & { menu_item: menu_item | null },
  quantity: number,
  newQuantity: number,
  currencyCode: string,
  guidanceBlock?: string
): Promise<WhatsAppInteractiveMessage> => {
  const guide = guidanceBlock ? `\n\n${guidanceBlock}` : '';
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: 'Pedido actualizado' },
      body: { text: `Se aumentò la cantidad de ${quantity} para el platillo ${draftOrderItem.menu_item?.name} en el pedido. 
      \n\nCantidad actual: ${newQuantity} \n\n
      \n\nTotal: ${draftOrderItem.total_price.toNumber()} ${currencyCode} \n\n${guide}
      \n\n¿Querés seguir comprando? \n\nEscribe "Ver menu" para agregar más platillos.` },
      footer: { text: '¿Querés seguir comprando o finalizar tu orden?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'VIEW_CART', title: 'Volver al pedido' } },
          { type: 'reply', reply: { id: 'CHECKOUT', title: 'Finalizar pedido' } },
          { type: 'reply', reply: { id: 'CANCEL_ORDER', title: 'Cancelar pedido' } }
        ]
      }
    }
  };
};

export const decreaseItemQuantityFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  itemID: string | undefined,
  quantity: number
): Promise<WhatsAppInteractiveMessage | string | null> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;
  if (!phoneNumberId || !from || !itemID || itemID === undefined) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  await findOrCreateConversationState(conversation.id);

  const draftOrder = await handleDraftOrder(business, customer);

  const draftOrderItem = await handleDraftOrderItem(draftOrder, itemID);


  if (!draftOrderItem) return 'Ese producto ya no está disponible en tu pedido.';

  const newQuantity = draftOrderItem.quantity - quantity;
  if (newQuantity < 1) return 'La cantidad del platillo no puede ser menor a 1.';
  await prisma.draft_order_item.update({
    where: { id: draftOrderItem.id },
    data: { quantity: newQuantity }
  });

  const coverage = await syncOrderCoverageToConversationState(
    conversation.id,
    business.id,
    customer.phone_number
  );
  const guidance = formatCartGuidanceBlock(coverage);

  return await buildDecreaseItemQuantitySuccessMessage(
    draftOrderItem,
    quantity,
    draftOrder.currency ?? 'ARS',
    newQuantity,
    guidance
  );
};

export const increaseItemQuantityFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  itemID: string | undefined,
  quantity: number
): Promise<WhatsAppInteractiveMessage | string | null> => {
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;
  const maxQuantity = 10;
  if (!phoneNumberId || !from || !itemID || itemID === undefined) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  await findOrCreateConversationState(conversation.id);

  const draftOrder = await handleDraftOrder(business, customer);

  const draftOrderItem = await handleDraftOrderItem(draftOrder, itemID);


  if (!draftOrderItem) return 'Ese producto ya no está disponible en tu pedido.';

  const newQuantity = draftOrderItem.quantity + quantity;
  if (newQuantity > maxQuantity) return 'La cantidad del platillo no puede ser mayor a 10.';
  await prisma.draft_order_item.update({
    where: { id: draftOrderItem.id },
    data: { quantity: newQuantity }
  });

  const coverage = await syncOrderCoverageToConversationState(
    conversation.id,
    business.id,
    customer.phone_number
  );
  const guidance = formatCartGuidanceBlock(coverage);

  return await buildIncreaseItemQuantitySuccessMessage(
    draftOrderItem,
    quantity,
    newQuantity,
    business.currency_code ?? 'ARS',
    guidance
  );
};

export const handleConfirmAddItemFromWebhook = async (
  payload: WhatsAppWebhookPayload,
  itemIdentifier: string
): Promise<WhatsAppInteractiveMessage | string | null> => {

  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;
  const message = value?.messages?.[0];
  const from = message?.from;
  const phoneNumberId = value?.metadata?.phone_number_id;

  if (!phoneNumberId || !from || !itemIdentifier) return null;

  const business = await findBusinessByPhoneNumberId(phoneNumberId);
  if (!business) return null;

  const customer = await findOrCreateCustomer(business.id, from);
  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  await findOrCreateConversationState(conversation.id);

  return await buildConfirmAddItemMessage(
    business,
    conversation,
    customer,
    itemIdentifier
  );

};

const buildConfirmAddItemMessage = async (
  business: business,
  conversation: conversation,
  customer: customer,
  itemIdentifier: string
): Promise<WhatsAppInteractiveMessage | string | null> => {
  const cartItems = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: customer.phone_number,
      status: 'active'
    },
    include: {
      draft_order_item: {
        include: { menu_item: true }
      }
    }
  });
  if (!cartItems) return 'No se encontró el platillo.';
  const matchingItem = cartItems.draft_order_item.find(ci =>
    ci.menu_item?.id === itemIdentifier
  );
  if (!matchingItem) return 'No se encontró el platillo.';
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      header: { type: 'text', text: '¿Agregar ítem?' },
      body: { text: `¿Querés agregar *${matchingItem.menu_item?.name}* al pedido?` },
      footer: { text: '¿Querés agregar *${matchingItem.menu_item?.name}* al pedido?' },
      action: {
        buttons: [
          { type: 'reply', reply: { id: `CONFIRM_ADD:${matchingItem.menu_item?.id}`, title: '✅ Sí, agregar' } },
          { type: 'reply', reply: { id: 'VIEW_MENU', title: '⬅ Volver' } }
        ]
      }
    }
  };
};