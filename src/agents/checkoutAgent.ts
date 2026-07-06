/**
 * Agente ReAct dedicado al checkout.
 *
 * Se invoca desde `checkoutAgentNode` cuando hay una "sesión de checkout"
 * activa (flag `checkout_active` en metadata). Gestiona en lenguaje natural
 * los datos obligatorios para cerrar el pedido (tipo de entrega, dirección,
 * nombre) y luego muestra los botones de pago a través de tools-señal.
 *
 * El agente es más acotado que el agente principal: solo tiene tools
 * relacionadas con el checkout. No gestiona carrito ni menú.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage } from '@langchain/core/messages';
import { getReactReasonerLlm } from '../config/llm';
import { buildAgentHistoryMessages } from './conversationHistory';
import { buildCheckoutAgentSystemPrompt } from '../prompts/botPersonality';
import { resolvePersonalityForBusiness } from '../services/botPersonality.service';
import {
  getCartTool,
  saveCustomerNameTool,
  saveDeliveryAddressTool,
} from '../tools';
import { allCheckoutTools } from '../tools/checkout';
import type { EnrichedContext } from '../controllers/webhook/types';
import { formatBotUserMessage, normalizeMetadata } from '../services/productQuery/utils';
import { prisma } from '../lib/prisma';

// ---------------------------------------------------------------------------
// Cache de agentes por personalidad (mismo patrón que reactAgent.ts)
// ---------------------------------------------------------------------------

let cachedAgents = new Map<string, ReturnType<typeof createReactAgent>>();

const buildAgent = (personalityId: string, personalityPrompt: string) => {
  const cacheKey = `checkout:${personalityId}`;
  let agent = cachedAgents.get(cacheKey);
  if (!agent) {
    agent = createReactAgent({
      llm: getReactReasonerLlm(),
      tools: [...allCheckoutTools, getCartTool, saveCustomerNameTool, saveDeliveryAddressTool],
      prompt: buildCheckoutAgentSystemPrompt(personalityPrompt),
    });
    cachedAgents.set(cacheKey, agent);
  }
  return agent;
};

/** Solo para uso en tests: resetea el cache del agente de checkout. */
export const resetCheckoutAgentCacheForTesting = (): void => {
  cachedAgents = new Map();
};

// ---------------------------------------------------------------------------
// Context message [ESTADO DEL CHECKOUT]
// ---------------------------------------------------------------------------

export interface CheckoutAgentContext {
  hasAddress: boolean;
  isInCoverage: boolean;
  deliveryEnabled: boolean;
  takeawayEnabled: boolean;
}

const buildCheckoutContextMessage = async (
  ctx: EnrichedContext,
  checkoutCtx: CheckoutAgentContext
): Promise<string> => {
  const userMsg = ctx.message?.text?.body ?? '';
  const customerName = (ctx.customer as { name?: string | null })?.name?.trim() || null;
  const businessId =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { id: string }).id
      : '';
  const customerPhone =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { phone_number?: string }).phone_number ?? ctx.to
      : ctx.to;
  const conversationId = ctx.conversationId ?? '';

  // Estado del carrito resumido
  let cartSummary = 'sin datos (usá get_cart para obtenerlo)';
  let fulfillmentType = 'sin elegir';
  let paymentMethod = 'sin elegir';

  try {
    const draft = await prisma.draft_order.findFirst({
      where: { business_id: businessId, customer_phone: customerPhone, status: 'active' },
      include: {
        draft_order_item: {
          include: { menu_item: { select: { name: true } } },
        },
      },
    });

    if (draft) {
      const itemLines = draft.draft_order_item.map((i) => {
        const name = i.menu_item?.name ?? 'ítem';
        return `  - ${i.quantity}× ${name}`;
      });
      const total = Number(draft.total_amount).toLocaleString('es-AR');
      cartSummary = `${itemLines.join('\n')}\n  Total: $${total}`;
      fulfillmentType = draft.fulfillment_type ?? 'sin elegir';
      paymentMethod = draft.payment_method ?? 'sin elegir';
    }
  } catch {
    // Si falla la consulta, el agente usará get_cart
  }

  // Opciones de entrega disponibles según config
  const fulfillmentOptions: string[] = [];
  if (checkoutCtx.deliveryEnabled) fulfillmentOptions.push('DELIVERY');
  if (checkoutCtx.takeawayEnabled) fulfillmentOptions.push('TAKE_AWAY');
  const fulfillmentOptionsLabel = fulfillmentOptions.join(', ') || 'ninguna';

  const addressStatus = !checkoutCtx.hasAddress
    ? 'no cargada'
    : !checkoutCtx.isInCoverage
      ? 'cargada pero fuera de cobertura'
      : 'cargada y en cobertura';

  // Conteos de rechazo desde metadata del draft activo
  let nameRefusalCount = 0;
  let addressRefusalCount = 0;
  try {
    const cs = await prisma.conversation_state.findFirst({
      where: { conversation_id: conversationId },
      select: { metadata: true },
    });
    if (cs && typeof cs.metadata === 'object' && cs.metadata !== null) {
      const meta = cs.metadata as Record<string, unknown>;
      nameRefusalCount = (meta.name_refusal_count as number | undefined) ?? 0;
      addressRefusalCount = (meta.address_refusal_count as number | undefined) ?? 0;
    }
  } catch {
    // Si falla, usar 0 — no es crítico
  }

  const nameLabel = customerName
    ? customerName
    : nameRefusalCount > 0
      ? `no informado (rechazó ${nameRefusalCount} ${nameRefusalCount === 1 ? 'vez' : 'veces'})`
      : 'no informado';

  const addressLabel = addressRefusalCount > 0
    ? `${addressStatus} (rechazó ${addressRefusalCount} ${addressRefusalCount === 1 ? 'vez' : 'veces'})`
    : addressStatus;

  const lines = [
    `[ESTADO DEL CHECKOUT]`,
    `- Nombre del cliente: ${nameLabel}`,
    `- Tipo de entrega: ${fulfillmentType} (opciones habilitadas: ${fulfillmentOptionsLabel})`,
    `- Dirección de entrega: ${addressLabel}`,
    `- Método de pago: ${paymentMethod}`,
    `- Carrito:\n${cartSummary}`,
  ];

  return `${lines.join('\n')}\n\n${userMsg}`;
};

// ---------------------------------------------------------------------------
// Extracción de señales del agente
// ---------------------------------------------------------------------------

export interface CheckoutAgentSignals {
  presentFulfillmentOptions: boolean;
  presentPaymentOptions: boolean;
  handback: boolean;
  handbackReason: string | null;
  paymentMethod: 'cash' | 'online' | null;
}

const extractSignals = (messages: unknown[]): CheckoutAgentSignals => {
  const signals: CheckoutAgentSignals = {
    presentFulfillmentOptions: false,
    presentPaymentOptions: false,
    handback: false,
    handbackReason: null,
    paymentMethod: null,
  };

  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) continue;
    const m = msg as Record<string, unknown>;
    if (typeof m.tool_call_id !== 'string') continue;

    const rawContent = typeof m.content === 'string' ? m.content : null;
    if (!rawContent) continue;

    try {
      const data = JSON.parse(rawContent) as {
        signal?: string;
        reason?: string;
        paymentMethod?: string;
      };
      if (data.signal === 'present_fulfillment_options') {
        signals.presentFulfillmentOptions = true;
      }
      if (data.signal === 'present_payment_options') {
        signals.presentPaymentOptions = true;
      }
      if (data.signal === 'payment_method_saved') {
        if (data.paymentMethod === 'cash' || data.paymentMethod === 'online') {
          signals.paymentMethod = data.paymentMethod;
        }
      }
      if (data.signal === 'handback_to_main') {
        signals.handback = true;
        signals.handbackReason = data.reason ?? null;
      }
    } catch {
      /* ignorar mensajes no-JSON */
    }
  }

  return signals;
};

// ---------------------------------------------------------------------------
// Extracción del texto final del agente
// ---------------------------------------------------------------------------

const extractFinalText = (result: unknown): string | null => {
  if (typeof result !== 'object' || result === null) return null;
  const messages = (result as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1] as { content?: unknown };
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return (
      last.content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (typeof part === 'object' && part && 'text' in part) {
            return String((part as { text: unknown }).text ?? '');
          }
          return '';
        })
        .join('')
        .trim() || null
    );
  }
  return null;
};

// ---------------------------------------------------------------------------
// Resultado del agente de checkout
// ---------------------------------------------------------------------------

export interface CheckoutAgentResult {
  text: string;
  signals: CheckoutAgentSignals;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const runCheckoutAgent = async (
  ctx: EnrichedContext,
  checkoutCtx: CheckoutAgentContext
): Promise<CheckoutAgentResult | null> => {
  const businessId =
    typeof ctx.business === 'object' && ctx.business
      ? (ctx.business as { id: string }).id
      : '';
  if (!businessId) return null;

  const { id: personalityId, promptText } =
    await resolvePersonalityForBusiness(businessId);
  const agent = buildAgent(personalityId, promptText);

  const customerId =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { id: string }).id
      : '';
  const customerPhone =
    typeof ctx.customer === 'object' && ctx.customer
      ? (ctx.customer as { phone_number?: string }).phone_number ?? ctx.to
      : ctx.to;
  const conversationId = ctx.conversationId;
  const conversationStartedAt =
    typeof ctx.conversation === 'object' && ctx.conversation
      ? (ctx.conversation as { started_at?: Date }).started_at?.toISOString() ?? ''
      : '';

  const contextMessage = await buildCheckoutContextMessage(ctx, checkoutCtx);

  const history = await buildAgentHistoryMessages({
    conversationId,
    startedAt:
      typeof ctx.conversation === 'object' && ctx.conversation
        ? (ctx.conversation as { started_at?: Date }).started_at ?? null
        : null,
    currentMessageId: ctx.message?.id ?? null,
  });

  const inputs = {
    messages: [...history, new HumanMessage(contextMessage)],
  };

  const out = await agent.invoke(inputs, {
    recursionLimit: 10,
    configurable: { businessId, customerId, customerPhone, conversationId, conversationStartedAt },
  });

  const rawText = extractFinalText(out);
  const agentMessages = (out as { messages?: unknown[] }).messages ?? [];
  const signals = extractSignals(agentMessages);

  const text = rawText
    ? rawText.startsWith('🤖')
      ? rawText
      : formatBotUserMessage('Checkout', '🛍️', rawText)
    : formatBotUserMessage('Cerrando pedido', '🛍️', 'Estoy procesando tu pedido, un momento...');

  return { text, signals };
};
