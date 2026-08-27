import type { AgentState } from '../../src/graph/state';
import type {
  HandlerResult,
  WhatsAppWebhookPayload,
} from '../../src/controllers/webhook/types';
import { E2E_CUSTOMER_PHONE, E2E_PHONE_NUMBER_ID } from './env';

let msgCounter = 0;

export const buildTextPayload = (body: string): WhatsAppWebhookPayload => ({
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: E2E_PHONE_NUMBER_ID },
            messages: [
              {
                from: E2E_CUSTOMER_PHONE,
                type: 'text',
                id: `wamid.e2e-${Date.now()}-${++msgCounter}`,
                text: { body },
              },
            ],
          },
        },
      ],
    },
  ],
});

export const buildInteractivePayload = (replyId: string): WhatsAppWebhookPayload => ({
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: E2E_PHONE_NUMBER_ID },
            messages: [
              {
                from: E2E_CUSTOMER_PHONE,
                type: 'interactive',
                id: `wamid.e2e-${Date.now()}-${++msgCounter}`,
                interactive: {
                  type: 'button_reply',
                  button_reply: { id: replyId, title: replyId },
                },
              },
            ],
          },
        },
      ],
    },
  ],
});

/** Respuesta a fila de lista WA (p. ej. picker de variación `ADD_ITEM:…:v0`). */
export const buildListReplyPayload = (replyId: string): WhatsAppWebhookPayload => ({
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: E2E_PHONE_NUMBER_ID },
            messages: [
              {
                from: E2E_CUSTOMER_PHONE,
                type: 'interactive',
                id: `wamid.e2e-${Date.now()}-${++msgCounter}`,
                interactive: {
                  type: 'list_reply',
                  list_reply: { id: replyId, title: replyId.slice(0, 24) },
                },
              },
            ],
          },
        },
      ],
    },
  ],
});

export const extractHandlerText = (result: HandlerResult | null | undefined): string => {
  if (!result) return '';
  const parts: string[] = [];
  const main =
    typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content).slice(0, 400);
  parts.push(main);
  for (const fu of result.followUps ?? []) {
    if (fu.type === 'text' && fu.message) parts.push(fu.message);
    if (fu.type === 'list') parts.push('[followUp list]');
    if (fu.type === 'interactive') parts.push('[followUp interactive]');
  }
  return parts.join('\n');
};

/** Fija personalidad neutral + humanize off para E2E reproducibles (no dependen del panel admin). */
export const pinE2eBusinessConfig = async (businessId: string): Promise<void> => {
  const { upsertBusinessConfig } = await import('../../src/services/businessConfig.service');
  const { getDefaultNeutralPersonalityId } = await import('../../src/services/botPersonality.service');
  const neutralId = await getDefaultNeutralPersonalityId();
  await upsertBusinessConfig(businessId, {
    bot_personality_id: neutralId,
    humanize_messages: false,
  });
};

export const hasHandlerResponse = (result: HandlerResult | null | undefined): boolean => {
  if (!result) return false;
  if (result.isInteractive) return true;
  if (result.followUps?.length) return true;
  const content =
    typeof result.content === 'string' ? result.content.trim() : JSON.stringify(result.content);
  return content.length > 0;
};

export const hasListFollowUp = (result: HandlerResult | null | undefined): boolean =>
  Boolean(result?.followUps?.some((fu) => fu.type === 'list'));

export const hasInteractiveFollowUp = (result: HandlerResult | null | undefined): boolean =>
  Boolean(result?.followUps?.some((fu) => fu.type === 'interactive'));

export const getConversationMetadata = (
  state: AgentState
): Record<string, unknown> | undefined =>
  state.workingConversationState?.metadata as Record<string, unknown> | undefined;

/** Metadata recién persistida (algunos nodos no refrescan `workingConversationState`). */
export const getFreshConversationMetadata = async (
  conversationId: string
): Promise<Record<string, unknown> | undefined> => {
  const { findOrCreateConversationState } = await import(
    '../../src/repositories/conversationState.repository'
  );
  const row = await findOrCreateConversationState(conversationId);
  return row.metadata as Record<string, unknown> | undefined;
};

export const isPartySizeGatePending = (meta: Record<string, unknown> | undefined): boolean =>
  meta?.awaitingPartySize === true ||
  meta?.awaitingPeopleCount === true ||
  (meta?.peopleCountResume != null && typeof meta.peopleCountResume === 'object');

export const isPartySizeStored = (
  meta: Record<string, unknown> | undefined,
  count: number
): boolean => meta?.peopleCount === count || meta?.requestedPartySize === count;

/** Sin party size persistido (gate híbrido puede preguntar en texto sin metadata). */
export const isPartySizeUnset = (meta: Record<string, unknown> | undefined): boolean =>
  meta?.peopleCount == null && meta?.requestedPartySize == null;

/** Señales estructurales de que se reanudó una consulta de menú (sin depender del copy del LLM). */
export const looksLikeMenuResume = (
  result: HandlerResult | null | undefined,
  options?: {
    lastReferencedProductId?: string | null;
    intent?: string | null;
  }
): boolean => {
  if (hasListFollowUp(result) || hasInteractiveFollowUp(result) || result?.isInteractive) {
    return true;
  }
  if (options?.lastReferencedProductId) return true;
  if (
    options?.intent === 'PRODUCT_QUERY' ||
    options?.intent === 'PRODUCT_ATTRIBUTE_QUESTION' ||
    options?.intent === 'ORDER_FOOD'
  ) {
    return hasHandlerResponse(result);
  }
  return hasHandlerResponse(result);
};

export type MainGraph = {
  invoke: (input: { webhookPayload: WhatsAppWebhookPayload }) => Promise<AgentState>;
};

export const loadMainGraph = async (): Promise<MainGraph> => {
  const { mainGraph } = await import('../../src/graph/mainGraph');
  return mainGraph as MainGraph;
};

export const runGraphTurn = async (
  graph: MainGraph,
  payload: WhatsAppWebhookPayload
): Promise<AgentState> =>
  graph.invoke({ webhookPayload: payload }) as Promise<AgentState>;

export type ResetE2eCustomerOptions = {
  /**
   * Si true (default), siembra `closed_order_confirmed_at` para no ejercitar el
   * diálogo de local cerrado (smoke happy path). Fase 2 closed-gate usa `false`.
   */
  confirmClosedOrder?: boolean;
};

export const resetE2eCustomer = async (
  options?: ResetE2eCustomerOptions
): Promise<{ businessId: string; conversationId: string }> => {
  const confirmClosedOrder = options?.confirmClosedOrder !== false;
  const { prisma } = await import('../../src/lib/prisma');
  const { findBusinessByPhoneNumberId } = await import('../../src/repositories/business.repository');
  const { patchConversationMetadata, omitConversationMetadataKeys } = await import(
    '../../src/repositories/conversationState.repository'
  );
  const { updateCustomerName } = await import('../../src/repositories');
  const { findOrCreateCustomer } = await import('../../src/repositories/customer.repository');
  const { createOrGetOpenConversation } = await import('../../src/repositories/conversation.repository');
  const { findOrCreateConversationState, updateConversationState } = await import(
    '../../src/repositories/conversationState.repository'
  );
  const { clearCheckoutSession } = await import('../../src/graph/nodes/checkout/index');

  const business = await findBusinessByPhoneNumberId(E2E_PHONE_NUMBER_ID);
  if (!business) {
    throw new Error(`Negocio no encontrado para phone_number_id=${E2E_PHONE_NUMBER_ID}`);
  }

  await pinE2eBusinessConfig(business.id);

  const customer = await findOrCreateCustomer(business.id, E2E_CUSTOMER_PHONE);
  await updateCustomerName(customer.id, 'E2E Test');

  const conversation = await createOrGetOpenConversation(business.id, customer.id);
  const conversationId = conversation.id;

  await clearCheckoutSession(conversationId);
  await findOrCreateConversationState(conversationId);

  // Aísla el historial: runs previos (u otros entornos) dejan filas 'ai'/'user'
  // en la misma conversación abierta y rompen aserciones de agent-history.
  await prisma.conversation_message.deleteMany({
    where: { conversation_id: conversationId },
  });

  // Happy path: si el local está cerrado pero opera (`orders_when_closed`),
  // el gate de ADD_ITEM pide confirmación. Sembramos el flag como si el cliente
  // ya hubiera aceptado pedir fuera de horario en esta conversación.
  await patchConversationMetadata(conversationId, {
    checkout_active: false,
    awaitingPeopleCount: false,
    awaitingPartySize: false,
    awaiting_name: false,
    pending_fulfillment_action: null,
    requestedPartySize: 2,
    peopleCount: 2,
    ...(confirmClosedOrder
      ? { closed_order_confirmed_at: new Date().toISOString() }
      : {}),
  });
  const omitKeys = [
    'peopleCountResume',
    'lastCtaPayload',
    'lastCtaShownAt',
    'lastCtaProductId',
    'lastOffer',
    'pendingProductSelection',
    'candidateProductIds',
    'reservation_agent_active',
    'reservation_draft',
    'onboarding_step',
    'onboarding_started_at',
    'temp_address',
    'awaiting_address',
    'pending_closed_add_item',
    'pendingVariation',
    'pendingAddQuantity',
    'pendingItemNote',
    ...(confirmClosedOrder ? [] : (['closed_order_confirmed_at'] as const)),
  ];
  await omitConversationMetadataKeys(conversationId, [...omitKeys]);

  await updateConversationState(conversationId, {
    mode: 'GLOBAL',
    current_intent: null,
  } as Parameters<typeof updateConversationState>[1]);

  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: business.id,
      customer_phone: E2E_CUSTOMER_PHONE,
      status: 'active',
    },
    select: { id: true },
  });
  if (draft) {
    await prisma.draft_order_item.deleteMany({ where: { draft_order_id: draft.id } });
    await prisma.draft_order.update({
      where: { id: draft.id },
      data: { fulfillment_type: null, payment_method: null, total_amount: 0 },
    });
  }

  return { businessId: business.id, conversationId };
};

export type E2eMenuProduct = {
  id: string;
  name: string;
  variations: string[];
  serves_people: number | null;
};

/**
 * Producto apto para happy path de carrito:
 * - preferir keyword "ceviche"
 * - sin variaciones (evita picker `:vN`)
 * - con `serves_people` tal que, con party=2 del reset, no abra pendingAddQuantity
 */
export const findE2eAddableProduct = async (
  businessId: string,
  options?: { partySize?: number; keyword?: string }
): Promise<E2eMenuProduct> => {
  const partySize = options?.partySize ?? 2;
  const keyword = options?.keyword ?? 'ceviche';
  const { prisma } = await import('../../src/lib/prisma');
  const { suggestAddQuantity } = await import('../../src/services/addQuantitySuggestion');
  const { hasVariations } = await import('../../src/services/menu/menuItemVariations');
  const { MenuService } = await import('../../src/services/menu.service');

  const ranked = await MenuService.searchMenuItemsByKeyword({ businessId, keyword });
  const rankedIds = ranked.map((item) => item.id);

  const candidates = await prisma.menu_item.findMany({
    where: {
      business_id: businessId,
      is_available: true,
      ...(rankedIds.length
        ? { id: { in: rankedIds } }
        : { name: { contains: keyword, mode: 'insensitive' } }),
    },
    select: { id: true, name: true, variations: true, serves_people: true },
  });

  const byId = new Map(candidates.map((item) => [item.id, item]));
  const ordered: E2eMenuProduct[] = [];
  for (const id of rankedIds) {
    const item = byId.get(id);
    if (item) ordered.push(item);
  }
  for (const item of candidates) {
    if (!rankedIds.includes(item.id)) ordered.push(item);
  }

  const plain = ordered.filter((item) => !hasVariations(item));
  const noQtyGate = plain.find((item) => {
    const { suggestedQuantity } = suggestAddQuantity({
      partySize,
      servesPeople: item.serves_people,
    });
    return suggestedQuantity < 2;
  });
  if (noQtyGate) {
    return {
      id: noQtyGate.id,
      name: noQtyGate.name?.trim() || 'Producto',
      variations: noQtyGate.variations,
      serves_people: noQtyGate.serves_people,
    };
  }
  if (plain[0]) {
    return {
      id: plain[0].id,
      name: plain[0].name?.trim() || 'Producto',
      variations: plain[0].variations,
      serves_people: plain[0].serves_people,
    };
  }
  if (ordered[0]) {
    return {
      id: ordered[0].id,
      name: ordered[0].name?.trim() || 'Producto',
      variations: ordered[0].variations,
      serves_people: ordered[0].serves_people,
    };
  }
  throw new Error(`No hay producto "${keyword}" disponible para e2e`);
};

/** @deprecated Preferí `findE2eAddableProduct` (filtra variación/cantidad). */
export const findCevicheProduct = async (businessId: string) =>
  findE2eAddableProduct(businessId);

/**
 * Producto con variaciones obligatorias (para gate `pendingVariation` / picker `:vN`).
 * Prefiere ítems sin gate de cantidad con el partySize dado; si no hay, el primero con variaciones.
 */
export const findE2eProductWithVariations = async (
  businessId: string,
  options?: { partySize?: number }
): Promise<E2eMenuProduct> => {
  const partySize = options?.partySize ?? 2;
  const { prisma } = await import('../../src/lib/prisma');
  const { suggestAddQuantity } = await import('../../src/services/addQuantitySuggestion');
  const { hasVariations } = await import('../../src/services/menu/menuItemVariations');

  const items = await prisma.menu_item.findMany({
    where: { business_id: businessId, is_available: true },
    select: { id: true, name: true, variations: true, serves_people: true },
  });
  const withVars = items.filter((item) => hasVariations(item));
  if (withVars.length === 0) {
    throw new Error('No hay producto disponible con variaciones para e2e');
  }

  const noQtyGate = withVars.find((item) => {
    const { suggestedQuantity } = suggestAddQuantity({
      partySize,
      servesPeople: item.serves_people,
    });
    return suggestedQuantity < 2;
  });
  const picked = noQtyGate ?? withVars[0];
  return {
    id: picked.id,
    name: picked.name?.trim() || 'Producto',
    variations: picked.variations,
    serves_people: picked.serves_people,
  };
};

/**
 * Producto sin variaciones que, con el partySize dado, dispara `pendingAddQuantity`
 * (`suggestedQuantity >= 2` vía serves/party).
 */
export const findE2eQuantityGateProduct = async (
  businessId: string,
  options?: { partySize?: number }
): Promise<E2eMenuProduct & { suggestedQuantity: number }> => {
  const partySize = options?.partySize ?? 2;
  const { prisma } = await import('../../src/lib/prisma');
  const { suggestAddQuantity, needsAddQuantityConfirmation } = await import(
    '../../src/services/addQuantitySuggestion'
  );
  const { hasVariations } = await import('../../src/services/menu/menuItemVariations');

  const items = await prisma.menu_item.findMany({
    where: { business_id: businessId, is_available: true },
    select: { id: true, name: true, variations: true, serves_people: true },
  });

  for (const item of items) {
    if (hasVariations(item)) continue;
    const { suggestedQuantity } = suggestAddQuantity({
      partySize,
      servesPeople: item.serves_people,
    });
    if (
      needsAddQuantityConfirmation({ suggestedQuantity, partySize }) &&
      suggestedQuantity >= 2
    ) {
      return {
        id: item.id,
        name: item.name?.trim() || 'Producto',
        variations: item.variations,
        serves_people: item.serves_people,
        suggestedQuantity,
      };
    }
  }
  throw new Error(
    `No hay producto sin variaciones que dispare pendingAddQuantity (partySize=${partySize})`
  );
};

type BusinessHoursSnapshot = {
  id: string;
  day_of_week: number;
  opens_at: string;
  closes_at: string;
  is_closed: boolean;
};

/**
 * Fuerza horario cerrado en BD (snapshot + restore) para ejercitar el gate
 * `businessClosedButOperating` sin depender del reloj.
 * Requiere `operate_when_closed` + `orders_when_closed` ya activos en el negocio.
 */
export const forceBusinessClosedForE2e = async (
  businessId: string
): Promise<{ restore: () => Promise<void> }> => {
  const { prisma } = await import('../../src/lib/prisma');
  const snapshot: BusinessHoursSnapshot[] = await prisma.business_hours.findMany({
    where: { business_id: businessId },
    select: {
      id: true,
      day_of_week: true,
      opens_at: true,
      closes_at: true,
      is_closed: true,
    },
  });

  if (snapshot.length === 0) {
    throw new Error('Negocio sin business_hours: no se puede forzar cerrado para e2e');
  }

  await prisma.business_hours.updateMany({
    where: { business_id: businessId },
    data: { is_closed: true, opens_at: '00:00', closes_at: '00:00' },
  });

  return {
    restore: async () => {
      for (const row of snapshot) {
        await prisma.business_hours.update({
          where: { id: row.id },
          data: {
            day_of_week: row.day_of_week,
            opens_at: row.opens_at,
            closes_at: row.closes_at,
            is_closed: row.is_closed,
          },
        });
      }
    },
  };
};

/** Primer botón de pago ofrecido por el negocio (p. ej. PAY_TRANSFER). */
export const getOfferedE2ePayButtonId = async (
  businessId: string
): Promise<{ buttonId: string; methodId: string }> => {
  const { getBusinessConfig } = await import('../../src/services/businessConfig.service');
  const { listOfferedPaymentMethods } = await import(
    '../../src/services/paymentMethods.service'
  );
  const cfg = await getBusinessConfig(businessId);
  const offered = await listOfferedPaymentMethods(businessId, {
    externalDeliveryEnabled: cfg.external_delivery_enabled,
  });
  if (offered.length === 0) {
    throw new Error('Negocio sin métodos de pago activos para e2e');
  }
  return { buttonId: offered[0].buttonId, methodId: offered[0].id };
};

export const getActiveDraftItems = async (
  businessId: string
): Promise<
  Array<{
    product_id: string | null;
    quantity: number;
    variation: string | null;
  }>
> => {
  const { prisma } = await import('../../src/lib/prisma');
  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: businessId,
      customer_phone: E2E_CUSTOMER_PHONE,
      status: 'active',
    },
    select: {
      draft_order_item: {
        select: { product_id: true, quantity: true, variation: true },
      },
    },
  });
  return draft?.draft_order_item ?? [];
};

export const findLatestOrderForE2eCustomer = async (
  businessId: string
): Promise<{
  id: string;
  status: string;
  payment_status: string;
  payment_method: string | null;
  fulfillment_type: string | null;
  order_item: Array<{ menu_item_id: string | null; quantity: number; variation: string | null }>;
} | null> => {
  const { prisma } = await import('../../src/lib/prisma');
  const { findOrCreateCustomer } = await import('../../src/repositories/customer.repository');
  const customer = await findOrCreateCustomer(businessId, E2E_CUSTOMER_PHONE);
  const order = await prisma.orders.findFirst({
    where: { business_id: businessId, customer_id: customer.id },
    orderBy: { created_at: 'desc' },
    select: {
      id: true,
      status: true,
      payment_status: true,
      payment_method: true,
      fulfillment_type: true,
      order_item: {
        select: { menu_item_id: true, quantity: true, variation: true },
      },
    },
  });
  return order;
};

const extractListRowIds = (result: HandlerResult | null | undefined): string[] => {
  if (!result) return [];
  const ids: string[] = [];
  const collect = (content: unknown) => {
    if (!content || typeof content !== 'object') return;
    const interactive = (content as { interactive?: unknown }).interactive;
    if (!interactive || typeof interactive !== 'object') return;
    const action = (interactive as { action?: unknown }).action;
    if (!action || typeof action !== 'object') return;
    const sections = (action as { sections?: unknown }).sections;
    if (!Array.isArray(sections)) return;
    for (const section of sections) {
      const rows = (section as { rows?: unknown })?.rows;
      if (!Array.isArray(rows)) continue;
      for (const row of rows) {
        const id = (row as { id?: unknown })?.id;
        if (typeof id === 'string' && id.startsWith('ADD_ITEM:')) ids.push(id);
      }
    }
  };
  collect(result.content);
  for (const fu of result.followUps ?? []) {
    if (fu.type === 'list' && fu.listMessage) collect(fu.listMessage);
  }
  return ids;
};

/**
 * Happy path botón: ADD_ITEM → (variación) → (cantidad) → ítem en carrito.
 * Asume `closed_order_confirmed_at` del reset si el local está cerrado.
 */
export const addItemViaButtonHappyPath = async (params: {
  graph: MainGraph;
  businessId: string;
  productId: string;
  quantity?: number;
}): Promise<AgentState> => {
  const { CONFIRM_CLOSED_ORDER } = await import('../../src/services/businessHours.service');
  const { parseAddItemButtonPayload } = await import(
    '../../src/controllers/webhook/utils'
  );
  const qty = params.quantity ?? 1;
  let payloadId = `ADD_ITEM:${params.productId}:${qty}`;
  let lastState = await runGraphTurn(params.graph, buildInteractivePayload(payloadId));

  for (let step = 0; step < 5; step++) {
    const items = await getActiveDraftItems(params.businessId);
    if (items.some((i) => i.product_id === params.productId)) return lastState;

    const meta = lastState.workingConversationState?.metadata as
      | Record<string, unknown>
      | undefined;
    const conversationId = lastState.conversation?.id;
    const freshMeta = conversationId
      ? await getFreshConversationMetadata(conversationId)
      : meta;

    if (freshMeta?.pending_closed_add_item) {
      lastState = await runGraphTurn(
        params.graph,
        buildInteractivePayload(CONFIRM_CLOSED_ORDER)
      );
      continue;
    }

    const listIds = extractListRowIds(lastState.handlerResult);
    const variationRow = listIds.find((id) => /:v\d{1,2}$/.test(id));
    if (variationRow) {
      lastState = await runGraphTurn(params.graph, buildListReplyPayload(variationRow));
      continue;
    }

    const pendingQty = freshMeta?.pendingAddQuantity as
      | { productId?: string; suggestedQuantity?: number; variation?: string | null }
      | undefined;
    if (pendingQty?.productId === params.productId) {
      const suggested =
        typeof pendingQty.suggestedQuantity === 'number' && pendingQty.suggestedQuantity >= 1
          ? Math.min(99, Math.floor(pendingQty.suggestedQuantity))
          : qty;
      // Reusar índice de variación si el pending la trae y el producto la tiene.
      const prev = parseAddItemButtonPayload(payloadId);
      const varSuffix =
        prev.variationIndex != null ? `:v${prev.variationIndex}` : '';
      payloadId = `ADD_ITEM:${params.productId}:${suggested}${varSuffix}`;
      lastState = await runGraphTurn(params.graph, buildInteractivePayload(payloadId));
      continue;
    }

    break;
  }

  const finalItems = await getActiveDraftItems(params.businessId);
  if (!finalItems.some((i) => i.product_id === params.productId)) {
    throw new Error(
      `addItemViaButtonHappyPath: producto no en carrito (productId=${params.productId})`
    );
  }
  return lastState;
};

export const getActiveDraftItemCount = async (
  businessId: string
): Promise<number> => {
  const { prisma } = await import('../../src/lib/prisma');
  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: businessId,
      customer_phone: E2E_CUSTOMER_PHONE,
      status: 'active',
    },
    select: { _count: { select: { draft_order_item: true } } },
  });
  return draft?._count.draft_order_item ?? 0;
};

/** Fulfillment del draft activo (fuente de verdad; no copy del LLM). */
export const getActiveDraftFulfillmentType = async (
  businessId: string
): Promise<string | null> => {
  const { prisma } = await import('../../src/lib/prisma');
  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: businessId,
      customer_phone: E2E_CUSTOMER_PHONE,
      status: 'active',
    },
    select: { fulfillment_type: true },
  });
  return draft?.fulfillment_type ?? null;
};

/**
 * Segundo producto distinto del primero para multi-ítem / corrección.
 * Preferí sin variaciones y sin gate de cantidad; si no hay, acepta qty-gate
 * (el caller debe usar `resolvePendingAddGates` / `addItemViaButtonHappyPath`).
 */
export const findE2eSecondAddableProduct = async (
  businessId: string,
  options: { excludeId: string; preferKeyword?: string; partySize?: number }
): Promise<E2eMenuProduct> => {
  const partySize = options.partySize ?? 2;
  const preferKeyword = options.preferKeyword ?? 'papa';
  const { prisma } = await import('../../src/lib/prisma');
  const { suggestAddQuantity } = await import('../../src/services/addQuantitySuggestion');
  const { hasVariations } = await import('../../src/services/menu/menuItemVariations');
  const { MenuService } = await import('../../src/services/menu.service');

  const score = (item: E2eMenuProduct): number => {
    if (item.id === options.excludeId) return -1;
    const withVars = hasVariations(item);
    const { suggestedQuantity } = suggestAddQuantity({
      partySize,
      servesPeople: item.serves_people,
    });
    const qtyGate = suggestedQuantity >= 2;
    // Mayor = mejor: sin var + sin qty > sin var + qty > con var
    if (!withVars && !qtyGate) return 3;
    if (!withVars) return 2;
    return 1;
  };

  const pickBest = (items: E2eMenuProduct[]): E2eMenuProduct | null => {
    let best: E2eMenuProduct | null = null;
    let bestScore = 0;
    for (const item of items) {
      const s = score(item);
      if (s > bestScore) {
        best = item;
        bestScore = s;
      }
    }
    return best;
  };

  const ranked = await MenuService.searchMenuItemsByKeyword({
    businessId,
    keyword: preferKeyword,
  });
  const rankedIds = ranked.map((item) => item.id);
  const candidates = await prisma.menu_item.findMany({
    where: {
      business_id: businessId,
      is_available: true,
      ...(rankedIds.length
        ? { id: { in: rankedIds } }
        : { name: { contains: preferKeyword, mode: 'insensitive' } }),
    },
    select: { id: true, name: true, variations: true, serves_people: true },
  });
  const byId = new Map(candidates.map((item) => [item.id, item]));
  const ordered: E2eMenuProduct[] = [];
  for (const id of rankedIds) {
    const item = byId.get(id);
    if (item) ordered.push(item);
  }
  for (const item of candidates) {
    if (!rankedIds.includes(item.id)) ordered.push(item);
  }

  const preferred = pickBest(ordered);
  if (preferred && preferred.id !== options.excludeId) {
    return {
      id: preferred.id,
      name: preferred.name?.trim() || 'Producto',
      variations: preferred.variations,
      serves_people: preferred.serves_people,
    };
  }

  const all = await prisma.menu_item.findMany({
    where: { business_id: businessId, is_available: true },
    select: { id: true, name: true, variations: true, serves_people: true },
  });
  const fallback = pickBest(all);
  if (!fallback || fallback.id === options.excludeId) {
    throw new Error(
      `No hay segundo producto addable distinto de ${options.excludeId} para e2e`
    );
  }
  return {
    id: fallback.id,
    name: fallback.name?.trim() || 'Producto',
    variations: fallback.variations,
    serves_people: fallback.serves_people,
  };
};

/** Cuenta mensajes 'user' persistidos (historial real entre turnos de una conversación). */
export const countUserMessages = async (conversationId: string): Promise<number> => {
  const { prisma } = await import('../../src/lib/prisma');
  return prisma.conversation_message.count({
    where: { conversation_id: conversationId, sender: 'user' },
  });
};

/** Suma de quantity en líneas del borrador activo (detecta incrementos sin nueva fila). */
export const getActiveDraftItemQuantitySum = async (
  businessId: string
): Promise<number> => {
  const { prisma } = await import('../../src/lib/prisma');
  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: businessId,
      customer_phone: E2E_CUSTOMER_PHONE,
      status: 'active',
    },
    select: { draft_order_item: { select: { quantity: true } } },
  });
  return (
    draft?.draft_order_item.reduce((sum, item) => sum + (item.quantity ?? 0), 0) ?? 0
  );
};

export const disconnectPrisma = async (): Promise<void> => {
  const { prisma } = await import('../../src/lib/prisma');
  await prisma.$disconnect();
};
