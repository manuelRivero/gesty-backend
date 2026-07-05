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

export const resetE2eCustomer = async (): Promise<{ businessId: string; conversationId: string }> => {
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

  await patchConversationMetadata(conversationId, {
    checkout_active: false,
    awaitingPeopleCount: false,
    awaitingPartySize: false,
    awaiting_name: false,
    pending_fulfillment_action: null,
    requestedPartySize: 2,
    peopleCount: 2,
  });
  await omitConversationMetadataKeys(conversationId, [
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
  ]);

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
      data: { fulfillment_type: null, total_amount: 0 },
    });
  }

  return { businessId: business.id, conversationId };
};

export const findCevicheProduct = async (businessId: string) => {
  const { MenuService } = await import('../../src/services/menu.service');
  const items = await MenuService.searchMenuItemsByKeyword({
    businessId,
    keyword: 'ceviche',
  });
  const product = items[0];
  if (!product) throw new Error('No hay producto "ceviche" en el menú de prueba');
  return product;
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
