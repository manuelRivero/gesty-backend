/**
 * Nodo LangGraph del agente de checkout dedicado.
 *
 * Captura todos los turnos mientras `metadata.checkout_active` está activo
 * (texto libre e interactivos) y los delega al `checkoutAgent`.
 *
 * Responsabilidades del nodo (no del agente):
 * - Activar `checkout_active` al primer CHECKOUT.
 * - Setear `fulfillment_type` en el draft cuando llegan los payloads de botón.
 * - Ejecutar `PayCashHandler`/`PayOnlineHandler` y limpiar la sesión.
 * - Adjuntar botones interactivos cuando el agente devuelve señales.
 * - Hacer handback al flujo normal limpiando el flag.
 */

import { prisma } from '../../../lib/prisma';
import {
  omitConversationMetadataKeys,
  patchConversationMetadata,
} from '../../../repositories/conversationState.repository';
import {
  EMPTY_CART_BOT_MESSAGE,
  PAYMENT_METHOD_PROMPT_BOT_MESSAGE,
} from '../../../services/productQuery/botMessages';
import { textResponse } from '../../../controllers/webhook/utils';
import { buildFulfillmentSelectionMessage } from '../gates/fulfillmentSelection';
import { PayCashHandler } from '../../../controllers/webhook/handlers/payCashHandler';
import { PayOnlineHandler } from '../../../controllers/webhook/handlers/payOnlineHandler';
import { runCheckoutAgent } from '../../../agents/checkoutAgent';
import type { CheckoutAgentContext } from '../../../agents/checkoutAgent';
import type { HandlerFollowUp, HandlerResult } from '../../../controllers/webhook/types';
import type { EnrichedContext } from '../../../controllers/webhook/types';
import type { WhatsAppInteractiveMessage } from '../../../domain/intent/whatsappTemplates';
import type { AgentState, AgentStateUpdate } from '../../state';
import { setDraftFulfillmentType } from '../../../tools/checkout';

// ---------------------------------------------------------------------------
// Mensaje de botones de pago (sin ajustes de precio en v1)
// ---------------------------------------------------------------------------

function buildPaymentButtonsMessage(): WhatsAppInteractiveMessage {
  return {
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: PAYMENT_METHOD_PROMPT_BOT_MESSAGE },
      action: {
        buttons: [
          { type: 'reply', reply: { id: 'PAY_ONLINE', title: '💳 Pago online' } },
          { type: 'reply', reply: { id: 'PAY_CASH', title: '💵 Efectivo' } },
        ],
      },
    },
  } as WhatsAppInteractiveMessage;
}

// ---------------------------------------------------------------------------
// Helper: limpiar sesión de checkout
// ---------------------------------------------------------------------------

export const clearCheckoutSession = async (conversationId: string): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [
    'checkout_active',
    'name_refusal_count',
    'address_refusal_count',
    'pending_fulfillment_action',
  ]);
};

// ---------------------------------------------------------------------------
// Activar sesión + validar carrito
// ---------------------------------------------------------------------------

export const activateCheckoutSessionIfCartHasItems = async (params: {
  businessId: string;
  phone: string;
  conversationId: string;
}): Promise<HandlerResult | null> => {
  const draft = await prisma.draft_order.findFirst({
    where: {
      business_id: params.businessId,
      customer_phone: params.phone,
      status: 'active',
    },
    select: { id: true, draft_order_item: { select: { id: true } } },
  });

  if (!draft || draft.draft_order_item.length === 0) {
    return textResponse(EMPTY_CART_BOT_MESSAGE);
  }

  await patchConversationMetadata(params.conversationId, { checkout_active: true });
  return null;
};

export const applyDefaultFulfillmentIfSingleOption = async (params: {
  businessId: string;
  phone: string;
  deliveryEnabled: boolean;
  takeawayEnabled: boolean;
}): Promise<void> => {
  if (params.deliveryEnabled && !params.takeawayEnabled) {
    await setDraftFulfillmentType(params.businessId, params.phone, 'DELIVERY');
  } else if (!params.deliveryEnabled && params.takeawayEnabled) {
    await setDraftFulfillmentType(params.businessId, params.phone, 'TAKE_AWAY');
  }
};

// ---------------------------------------------------------------------------
// Resolver respuesta del agente de checkout (compartido con NLP intercept)
// ---------------------------------------------------------------------------

export const resolveCheckoutAgentHandlerResult = async (params: {
  enrichedCtx: EnrichedContext;
  checkoutCtx: CheckoutAgentContext;
  conversationId: string;
}): Promise<HandlerResult> => {
  const { enrichedCtx, checkoutCtx, conversationId } = params;

  let agentResult: Awaited<ReturnType<typeof runCheckoutAgent>>;
  try {
    agentResult = await runCheckoutAgent(enrichedCtx, checkoutCtx);
  } catch (err) {
    console.error('[checkout-agent] error invocando el agente de checkout:', err);
    agentResult = null;
  }

  if (!agentResult) {
    return (
      textResponse(
        '🤖\n\n*Hubo un problema* 😔\n\nNo pude procesar tu pedido en este momento. ¿Podés intentarlo de nuevo?'
      ) ?? { content: '', isInteractive: false }
    );
  }

  const { text, signals } = agentResult;

  if (signals.handback) {
    await clearCheckoutSession(conversationId);
    console.log(
      JSON.stringify({
        event: '[checkout-agent] handback_to_main',
        reason: signals.handbackReason,
        conversationId,
      })
    );
    return { content: text, isInteractive: false, skipBodyHumanization: true };
  }

  if (signals.presentFulfillmentOptions) {
    const fulfillmentMessage = buildFulfillmentSelectionMessage();
    const followUp: HandlerFollowUp = {
      type: 'interactive',
      message: fulfillmentMessage as WhatsAppInteractiveMessage,
    };
    return {
      content: text,
      isInteractive: false,
      followUps: [followUp],
      skipBodyHumanization: true,
    };
  }

  if (signals.presentPaymentOptions) {
    const paymentMessage = buildPaymentButtonsMessage();
    const followUp: HandlerFollowUp = {
      type: 'interactive',
      message: paymentMessage as WhatsAppInteractiveMessage,
    };
    return {
      content: text,
      isInteractive: false,
      followUps: [followUp],
      skipBodyHumanization: true,
    };
  }

  return { content: text, isInteractive: false, skipBodyHumanization: true };
};

// ---------------------------------------------------------------------------
// Nodo principal
// ---------------------------------------------------------------------------

const payCashHandler = new PayCashHandler();
const payOnlineHandler = new PayOnlineHandler();

export const checkoutAgentNode = async (
  state: AgentState
): Promise<AgentStateUpdate> => {
  const ctx = state.webhookContext!;
  const enrichedBase = state.enrichedCtx as unknown as EnrichedContext;
  const conversation = state.conversation!;
  const business = state.business!;
  const customer = state.customer!;
  const businessConfig = state.businessConfig;
  const payloadId = ctx.payloadId;
  const conversationId = conversation.id;
  const phone = customer.phone_number ?? ctx.to;

  const deliveryEnabled = businessConfig?.delivery_enabled ?? true;
  const takeawayEnabled = businessConfig?.takeaway_enabled ?? false;

  if (payloadId === 'PAY_CASH') {
    const result = await payCashHandler.execute(enrichedBase as EnrichedContext);
    await clearCheckoutSession(conversationId);
    return {
      handlerResult: result ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  if (payloadId === 'PAY_ONLINE') {
    const result = await payOnlineHandler.execute(enrichedBase as EnrichedContext);
    await clearCheckoutSession(conversationId);
    return {
      handlerResult: result ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  if (payloadId === 'CANCEL_CHECKOUT') {
    await clearCheckoutSession(conversationId);
    return {
      handlerResult:
        textResponse(
          '🤖\n\n*Checkout cancelado* 👋\n\nTu pedido sigue guardado en el carrito. Avisame cuando quieras retomarlo.'
        ) ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  if (payloadId === 'FULFILLMENT_DELIVERY') {
    await setDraftFulfillmentType(business.id, phone, 'DELIVERY');
  } else if (payloadId === 'FULFILLMENT_TAKE_AWAY') {
    await setDraftFulfillmentType(business.id, phone, 'TAKE_AWAY');
  }

  if (payloadId === 'CHECKOUT') {
    const emptyCart = await activateCheckoutSessionIfCartHasItems({
      businessId: business.id,
      phone,
      conversationId,
    });
    if (emptyCart) {
      return { handlerResult: emptyCart, dataCollectionDelegated: true };
    }
  }

  const checkoutCtx: CheckoutAgentContext = {
    hasAddress: state.hasAddress,
    isInCoverage: state.isInCoverage,
    deliveryEnabled,
    takeawayEnabled,
  };

  await applyDefaultFulfillmentIfSingleOption({
    businessId: business.id,
    phone,
    deliveryEnabled,
    takeawayEnabled,
  });

  const handlerResult = await resolveCheckoutAgentHandlerResult({
    enrichedCtx: enrichedBase,
    checkoutCtx,
    conversationId,
  });

  return {
    handlerResult,
    dataCollectionDelegated: true,
  };
};
