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
import { textResponse, interactiveResponse } from '../../../controllers/webhook/utils';
import { buildFulfillmentSelectionMessage } from '../gates/fulfillmentSelection';
import { PayCashHandler } from '../../../controllers/webhook/handlers/payCashHandler';
import { PayOnlineHandler } from '../../../controllers/webhook/handlers/payOnlineHandler';
import { runCheckoutAgent } from '../../../agents/checkoutAgent';
import type { CheckoutAgentContext } from '../../../agents/checkoutAgent';
import type { HandlerFollowUp, HandlerResult } from '../../../controllers/webhook/types';
import type { EnrichedContext } from '../../../controllers/webhook/types';
import type { WhatsAppInteractiveMessage } from '../../../domain/intent/whatsappTemplates';
import type { AgentState, AgentStateUpdate } from '../../state';

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
// Helper: setear fulfillment_type en el draft activo
// ---------------------------------------------------------------------------

const setFulfillmentType = async (
  businessId: string,
  phone: string,
  type: 'DELIVERY' | 'TAKE_AWAY'
): Promise<void> => {
  const draft = await prisma.draft_order.findFirst({
    where: { business_id: businessId, customer_phone: phone, status: 'active' },
    select: { id: true },
  });
  if (!draft) return;
  await prisma.$executeRaw`
    UPDATE draft_order
    SET fulfillment_type = ${type}::"FulfillmentType"
    WHERE id = ${draft.id}::uuid
  `;
};

// ---------------------------------------------------------------------------
// Helper: limpiar sesión de checkout
// ---------------------------------------------------------------------------

const clearCheckoutSession = async (conversationId: string): Promise<void> => {
  await omitConversationMetadataKeys(conversationId, [
    'checkout_active',
    'name_refusal_count',
    'address_refusal_count',
  ]);
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

  // ── Pago en efectivo ──────────────────────────────────────────────────────
  if (payloadId === 'PAY_CASH') {
    const result = await payCashHandler.execute(enrichedBase as any);
    await clearCheckoutSession(conversationId);
    return {
      handlerResult: result ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  // ── Pago online ───────────────────────────────────────────────────────────
  if (payloadId === 'PAY_ONLINE') {
    const result = await payOnlineHandler.execute(enrichedBase as any);
    await clearCheckoutSession(conversationId);
    return {
      handlerResult: result ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  // ── Cancelar checkout ─────────────────────────────────────────────────────
  if (payloadId === 'CANCEL_CHECKOUT') {
    await clearCheckoutSession(conversationId);
    return {
      handlerResult: textResponse(
        '🤖\n\n*Checkout cancelado* 👋\n\nTu pedido sigue guardado en el carrito. Avisame cuando quieras retomarlo.'
      ) ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  // ── Selección de tipo de entrega ──────────────────────────────────────────
  if (payloadId === 'FULFILLMENT_DELIVERY') {
    await setFulfillmentType(business.id, phone, 'DELIVERY');
  } else if (payloadId === 'FULFILLMENT_TAKE_AWAY') {
    await setFulfillmentType(business.id, phone, 'TAKE_AWAY');
  }

  // ── Activar sesión de checkout en el primer turno ─────────────────────────
  if (payloadId === 'CHECKOUT') {
    const draft = await prisma.draft_order.findFirst({
      where: { business_id: business.id, customer_phone: phone, status: 'active' },
      select: { id: true, draft_order_item: { select: { id: true } } },
    });

    if (!draft || draft.draft_order_item.length === 0) {
      return {
        handlerResult: textResponse(EMPTY_CART_BOT_MESSAGE) ?? undefined,
        dataCollectionDelegated: true,
      };
    }

    await patchConversationMetadata(conversationId, { checkout_active: true });
  }

  // ── Invocar el agente de checkout ─────────────────────────────────────────
  const checkoutCtx: CheckoutAgentContext = {
    hasAddress: state.hasAddress,
    isInCoverage: state.isInCoverage,
    deliveryEnabled,
    takeawayEnabled,
  };

  let agentResult: Awaited<ReturnType<typeof runCheckoutAgent>>;
  try {
    agentResult = await runCheckoutAgent(enrichedBase, checkoutCtx);
  } catch (err) {
    console.error('[checkout-agent] error invocando el agente de checkout:', err);
    agentResult = null;
  }

  if (!agentResult) {
    return {
      handlerResult: textResponse(
        '🤖\n\n*Hubo un problema* 😔\n\nNo pude procesar tu pedido en este momento. ¿Podés intentarlo de nuevo?'
      ) ?? undefined,
      dataCollectionDelegated: true,
    };
  }

  const { text, signals } = agentResult;

  // ── Handback al flujo normal ───────────────────────────────────────────────
  if (signals.handback) {
    await clearCheckoutSession(conversationId);
    console.log(
      JSON.stringify({
        event: '[checkout-agent] handback_to_main',
        reason: signals.handbackReason,
        conversationId,
      })
    );
    return {
      handlerResult: { content: text, isInteractive: false },
      dataCollectionDelegated: true,
    };
  }

  // ── Señal: mostrar botones de tipo de entrega ─────────────────────────────
  if (signals.presentFulfillmentOptions) {
    const fulfillmentMessage = buildFulfillmentSelectionMessage();
    const followUp: HandlerFollowUp = { type: 'interactive', message: fulfillmentMessage as any };
    return {
      handlerResult: {
        content: text,
        isInteractive: false,
        followUps: [followUp],
      },
      dataCollectionDelegated: true,
    };
  }

  // ── Señal: mostrar botones de pago ────────────────────────────────────────
  if (signals.presentPaymentOptions) {
    const paymentMessage = buildPaymentButtonsMessage();
    const followUp: HandlerFollowUp = { type: 'interactive', message: paymentMessage as any };
    return {
      handlerResult: {
        content: text,
        isInteractive: false,
        followUps: [followUp],
      },
      dataCollectionDelegated: true,
    };
  }

  // ── Solo texto (pide datos o confirma) ────────────────────────────────────
  return {
    handlerResult: { content: text, isInteractive: false },
    dataCollectionDelegated: true,
  };
};
